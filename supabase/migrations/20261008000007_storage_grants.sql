-- =====================================================================
-- Storage buckets, realtime, and function privileges
-- =====================================================================

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public) values
  ('avatars', 'avatars', true),          -- profile photos (avatars/<user id>/...)
  ('chat', 'chat', false),               -- chat attachments (chat/<room folder>/...)
  ('attendance', 'attendance', false),   -- TIME IN / OUT selfies (attendance/<yyyy-mm-dd>/...)
  ('soa', 'soa', false),                 -- SOA supporting files (soa/<soa id>/...)
  ('prs', 'prs', false)                  -- scanned PRS photos (prs/<branch id>/...)
on conflict (id) do nothing;

create policy avatars_read on storage.objects for select using (bucket_id = 'avatars');
create policy avatars_write on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy chat_files_read on storage.objects for select to authenticated using (
  bucket_id = 'chat' and (storage.foldername(name))[1] in (select public.chat_room_folder(r) from unnest(public.my_chat_room_ids()) r));
create policy chat_files_write on storage.objects for insert to authenticated with check (
  bucket_id = 'chat' and (storage.foldername(name))[1] in (select public.chat_room_folder(r) from unnest(public.my_chat_room_ids()) r));

create policy attendance_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'attendance' and public.me_type() = 'HQ');
create policy attendance_files_read on storage.objects for select to authenticated
  using (bucket_id = 'attendance' and public.is_admin());

create policy soa_files_read on storage.objects for select to authenticated using (
  bucket_id = 'soa' and exists (select 1 from public.soas s where s.id::text = (storage.foldername(name))[1]
                                and public.can_see_soa(s.hq_code, s.status, s.approved_at)));
create policy soa_files_write on storage.objects for insert to authenticated with check (
  bucket_id = 'soa' and public.me_type() in ('HQ', 'Admin') and exists (select 1 from public.soas s
    where s.id::text = (storage.foldername(name))[1] and public.can_see_soa(s.hq_code, s.status, s.approved_at)));
create policy soa_files_delete on storage.objects for delete to authenticated using (
  bucket_id = 'soa' and public.me_type() in ('HQ', 'Admin') and exists (select 1 from public.soas s
    where s.id::text = (storage.foldername(name))[1] and public.can_see_soa(s.hq_code, s.status, s.approved_at)));

create policy prs_files_read on storage.objects for select to authenticated using (
  bucket_id = 'prs' and public.can_see_branch(((storage.foldername(name))[1])::uuid));
create policy prs_files_write on storage.objects for insert to authenticated with check (
  bucket_id = 'prs' and (storage.foldername(name))[1] = public.my_branch()::text);

-- ---------------------------------------------------------------- realtime (live chat)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ---------------------------------------------------------------- function privileges
-- Nothing is callable without logging in, except the username lookup and the SOA view-only link.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;

-- internal building blocks: only the workflow functions (security definer) call these
revoke execute on function
  public.next_seq(text, int), public.next_doc_no(text), public.queue_email(text[], text[], text, text),
  public.prs_write_items(uuid, jsonb), public.ensure_batch(text, text, date), public.sc_post_delivery(uuid),
  public.sc_check_negative(uuid, bigint[]), public.po_upsert_header(text, jsonb), public.sc_sync_product(),
  public.soa_hist(jsonb, text, text), public.attendance_autoclose()
from authenticated;

grant execute on function public.login_email(text) to anon;
grant execute on function public.soa_public(text, text) to anon;
grant execute on function public.norm_key(text), public.mnl_today(), public.mnl_now() to anon;
