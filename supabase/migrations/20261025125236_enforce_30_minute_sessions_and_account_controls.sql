
-- Bound each auth session to 30 minutes and reject revoked/expired session IDs
-- even while a previously issued JWT remains cryptographically unexpired.
create or replace function private.current_auth_session_valid()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
begin
  if v_user_id is null then return false; end if;
  begin
    v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when others then
    return false;
  end;
  if v_session_id is null then return false; end if;
  return exists (
    select 1 from auth.sessions s
    where s.id = v_session_id
      and s.user_id = v_user_id
      and s.created_at <= pg_catalog.now()
      and s.created_at > pg_catalog.now() - interval '30 minutes'
      and (s.not_after is null or s.not_after > pg_catalog.now())
  );
end;
$$;
revoke all on function private.current_auth_session_valid() from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.current_auth_session_valid() to authenticated;

create or replace function public.get_current_session_deadline()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_deadline timestamptz;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  begin
    v_session_id := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when others then
    raise exception 'invalid session' using errcode = '42501';
  end;
  select s.created_at + interval '30 minutes'
    into v_deadline
  from auth.sessions s
  where s.id = v_session_id and s.user_id = v_user_id
    and (s.not_after is null or s.not_after > pg_catalog.now());
  if v_deadline is null then
    raise exception 'session is revoked or unavailable' using errcode = '42501';
  end if;
  return v_deadline;
end;
$$;
revoke all on function public.get_current_session_deadline() from public, anon;
grant execute on function public.get_current_session_deadline() to authenticated;

drop policy if exists diary_items_select_own on public.diary_items;
create policy diary_items_select_own on public.diary_items
  for select to authenticated
  using ((select auth.uid()) = user_id and (select private.current_auth_session_valid()));

drop policy if exists diary_sync_state_select_own on public.diary_sync_state;
create policy diary_sync_state_select_own on public.diary_sync_state
  for select to authenticated
  using ((select auth.uid()) = user_id and (select private.current_auth_session_valid()));

drop policy if exists diary_users_receive_own_broadcast on realtime.messages;
create policy diary_users_receive_own_broadcast on realtime.messages
  for select to authenticated
  using (
    extension = 'broadcast'
    and (select realtime.topic()) = 'diary:' || (select auth.uid())::text
    and (select private.current_auth_session_valid())
  );

create or replace function public.apply_diary_delta(p_expected_revision bigint, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_revision bigint;
  v_next_revision bigint;
  v_updated_at timestamptz;
  v_key text;
  v_delta jsonb;
  v_payload jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if not private.current_auth_session_valid() then
    raise exception 'session is expired or revoked' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'object' then
    raise exception 'changes must be a JSON object' using errcode = '22023';
  end if;

  insert into public.diary_sync_state(user_id, revision, updated_at)
  values (v_user_id, 0, pg_catalog.clock_timestamp())
  on conflict (user_id) do nothing;
  select revision into v_current_revision
  from public.diary_sync_state
  where user_id = v_user_id
  for update;

  if p_expected_revision is null then
    if v_current_revision <> 0 then
      raise exception 'diary revision conflict' using errcode = '40001';
    end if;
  elsif v_current_revision <> p_expected_revision then
    raise exception 'diary revision conflict' using errcode = '40001';
  end if;

  foreach v_key in array array['plans','tasks','runs','completionEvents','entries']
  loop
    v_delta := p_changes -> v_key;
    if pg_catalog.jsonb_typeof(v_delta) is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_delta -> 'upsert') is distinct from 'array'
      or pg_catalog.jsonb_typeof(v_delta -> 'delete') is distinct from 'array' then
      raise exception 'invalid delta for collection %', v_key using errcode = '22023';
    end if;

    if exists (
      select 1 from pg_catalog.jsonb_array_elements(v_delta -> 'upsert') as x(item)
      where pg_catalog.jsonb_typeof(x.item) is distinct from 'object'
        or nullif(x.item ->> 'id', '') is null
    ) then
      raise exception 'each upsert record needs an id for collection %', v_key using errcode = '22023';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(v_delta -> 'delete') as x(item_id)
      where pg_catalog.jsonb_typeof(x.item_id) is distinct from 'string'
        or nullif(x.item_id #>> '{}', '') is null
    ) then
      raise exception 'delete IDs must be non-empty strings for collection %', v_key using errcode = '22023';
    end if;

    delete from public.diary_items as d
    where d.user_id = v_user_id and d.collection = v_key
      and d.item_id in (
        select x.item_id #>> '{}'
        from pg_catalog.jsonb_array_elements(v_delta -> 'delete') as x(item_id)
      );

    insert into public.diary_items(user_id, collection, item_id, item, updated_at)
    select v_user_id, v_key, x.item ->> 'id', x.item, pg_catalog.clock_timestamp()
    from pg_catalog.jsonb_array_elements(v_delta -> 'upsert') as x(item)
    on conflict (user_id, collection, item_id)
    do update set item = excluded.item, updated_at = excluded.updated_at;
  end loop;

  v_next_revision := v_current_revision + 1;
  v_updated_at := pg_catalog.clock_timestamp();
  update public.diary_sync_state set revision = v_next_revision, updated_at = v_updated_at
  where user_id = v_user_id;

  if pg_catalog.pg_column_size(p_changes) > 24576 then
    v_payload := pg_catalog.jsonb_build_object('revision', v_next_revision, 'updated_at', v_updated_at, 'full_refresh', true);
  else
    v_payload := pg_catalog.jsonb_build_object('revision', v_next_revision, 'updated_at', v_updated_at, 'changes', p_changes);
  end if;

  perform realtime.send(payload => v_payload, event => 'diary_changed', topic => 'diary:' || v_user_id::text, private => true);
  return pg_catalog.jsonb_build_object('revision', v_next_revision, 'updated_at', v_updated_at);
end;
$$;
revoke all on function public.apply_diary_delta(bigint, jsonb) from public, anon;

revoke all on function public.apply_diary_delta(bigint, jsonb) from public, anon;
grant execute on function public.apply_diary_delta(bigint, jsonb) to authenticated;

create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not private.current_auth_session_valid() then
    raise exception 'active authenticated session required' using errcode = '42501';
  end if;
  delete from auth.users where id = v_user_id;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('deleted', true);
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
