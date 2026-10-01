-- A private storage bucket for plan/schedule files uploaded to the plan-reader.
-- Files are uploaded directly from the browser (bypassing Vercel's ~4.5MB
-- serverless function payload limit, which raw file uploads through our own
-- API route would otherwise hit), then the server downloads and deletes them
-- using the service-role key once read.
--
-- Safe to re-run.

insert into storage.buckets (id, name, public)
values ('plan-uploads', 'plan-uploads', false)
on conflict (id) do nothing;

-- Authenticated users may only write into a folder named after their own
-- user id — the server (service-role key) handles reading and deleting, so
-- no select/delete policy is needed for ordinary users.
drop policy if exists "plan uploads: users write own folder" on storage.objects;
create policy "plan uploads: users write own folder" on storage.objects
  for insert
  with check (
    bucket_id = 'plan-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
