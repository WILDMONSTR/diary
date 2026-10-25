create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to postgres;

create table public.diary_documents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"plans":[],"tasks":[],"runs":[],"completionEvents":[],"entries":[]}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint diary_documents_data_is_object check (jsonb_typeof(data) = 'object')
);

alter table public.diary_documents enable row level security;

grant select, insert, update on public.diary_documents to authenticated;

create policy diary_documents_select_own
  on public.diary_documents
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy diary_documents_insert_own
  on public.diary_documents
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy diary_documents_update_own
  on public.diary_documents
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function private.set_diary_document_metadata()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := pg_catalog.clock_timestamp();
    new.updated_at := new.created_at;
    return new;
  end if;

  if new.user_id is distinct from old.user_id then
    raise exception 'diary owner cannot be changed';
  end if;

  new.created_at := old.created_at;
  if new.data is distinct from old.data then
    new.revision := old.revision + 1;
    new.updated_at := pg_catalog.clock_timestamp();
  else
    new.revision := old.revision;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

revoke all on function private.set_diary_document_metadata() from public, anon, authenticated;

create trigger diary_documents_set_metadata
  before insert or update on public.diary_documents
  for each row execute function private.set_diary_document_metadata();

create or replace function private.broadcast_diary_document_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

  perform realtime.send(
    payload => pg_catalog.jsonb_build_object(
      'revision', new.revision,
      'updated_at', new.updated_at
    ),
    event => 'diary_changed',
    topic => 'diary:' || new.user_id::text,
    private => true
  );
  return new;
end;
$$;

revoke all on function private.broadcast_diary_document_change() from public, anon, authenticated;

create trigger diary_documents_broadcast_change
  after insert or update on public.diary_documents
  for each row execute function private.broadcast_diary_document_change();

drop policy if exists diary_users_receive_own_broadcast on realtime.messages;
create policy diary_users_receive_own_broadcast
  on realtime.messages
  for select
  to authenticated
  using (
    extension = 'broadcast'
    and (select realtime.topic()) = 'diary:' || (select auth.uid())::text
  );
