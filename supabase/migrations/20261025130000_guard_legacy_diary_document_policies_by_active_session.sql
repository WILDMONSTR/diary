
-- Make legacy diary_documents session revocation/timeout behavior consistent
-- with the current diary_items store. The live app no longer syncs through this table.
drop policy if exists diary_documents_select_own on public.diary_documents;
create policy diary_documents_select_own on public.diary_documents
  for select to authenticated
  using ((select auth.uid()) = user_id and (select private.current_auth_session_valid()));

drop policy if exists diary_documents_insert_own on public.diary_documents;
create policy diary_documents_insert_own on public.diary_documents
  for insert to authenticated
  with check ((select auth.uid()) = user_id and (select private.current_auth_session_valid()));

drop policy if exists diary_documents_update_own on public.diary_documents;
create policy diary_documents_update_own on public.diary_documents
  for update to authenticated
  using ((select auth.uid()) = user_id and (select private.current_auth_session_valid()))
  with check ((select auth.uid()) = user_id and (select private.current_auth_session_valid()));
