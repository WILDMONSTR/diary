create or replace function private.broadcast_diary_document_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
  v_upsert jsonb;
  v_delete jsonb;
  v_key text;
  v_payload jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'diary owner cannot be changed';
    end if;
    if new.data is not distinct from old.data then
      return new;
    end if;
  end if;

  if auth.uid() is not null and auth.uid() is distinct from new.user_id then
    raise exception 'cannot broadcast another user diary change';
  end if;

  if tg_op = 'INSERT' then
    v_payload := pg_catalog.jsonb_build_object(
      'revision', new.revision,
      'updated_at', new.updated_at,
      'full_refresh', true
    );
  else
    foreach v_key in array array['plans','tasks','runs','completionEvents','entries']
    loop
      if pg_catalog.jsonb_typeof(new.data -> v_key) is distinct from 'array'
        or pg_catalog.jsonb_typeof(old.data -> v_key) is distinct from 'array' then
        raise exception 'diary data collections must be JSON arrays';
      end if;

      select coalesce(pg_catalog.jsonb_agg(n.item), '[]'::jsonb)
        into v_upsert
      from pg_catalog.jsonb_array_elements(new.data -> v_key) as n(item)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(old.data -> v_key) as o(item)
        where o.item ->> 'id' = n.item ->> 'id'
          and o.item is not distinct from n.item
      );

      select coalesce(pg_catalog.jsonb_agg(o.item ->> 'id'), '[]'::jsonb)
        into v_delete
      from pg_catalog.jsonb_array_elements(old.data -> v_key) as o(item)
      where o.item ? 'id'
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(new.data -> v_key) as n(item)
          where n.item ->> 'id' = o.item ->> 'id'
        );

      v_changes := v_changes || pg_catalog.jsonb_build_object(
        v_key,
        pg_catalog.jsonb_build_object('upsert', v_upsert, 'delete', v_delete)
      );
    end loop;

    if pg_catalog.pg_column_size(v_changes) > 24576 then
      v_payload := pg_catalog.jsonb_build_object(
        'revision', new.revision,
        'updated_at', new.updated_at,
        'full_refresh', true
      );
    else
      v_payload := pg_catalog.jsonb_build_object(
        'revision', new.revision,
        'updated_at', new.updated_at,
        'changes', v_changes
      );
    end if;
  end if;

  perform realtime.send(
    payload => v_payload,
    event => 'diary_changed',
    topic => 'diary:' || new.user_id::text,
    private => true
  );
  return new;
end;
$$;

revoke all on function private.broadcast_diary_document_change() from public, anon, authenticated;
