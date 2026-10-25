
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

  delete from public.diary_items where user_id = v_user_id;
  delete from public.diary_sync_state where user_id = v_user_id;
  delete from public.diary_documents where user_id = v_user_id;

  delete from auth.users where id = v_user_id;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object('deleted', true);
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- The event-trigger function is for database DDL events, not the browser API.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
