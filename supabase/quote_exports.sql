-- Keeps a copy of every PDF / Word quote exported from a saved quote.
-- Run once in the Supabase SQL editor. Safe to re-run.

insert into storage.buckets (id, name, public)
values ('quote-exports', 'quote-exports', false)
on conflict (id) do nothing;

create table if not exists quote_exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  quote_id uuid not null references quotes(id) on delete cascade,
  format text not null check (format in ('pdf', 'docx')),
  filename text not null,
  storage_path text not null,
  total numeric(12, 2) default 0,
  created_at timestamptz not null default now()
);
create index if not exists quote_exports_quote_idx on quote_exports(quote_id);

alter table quote_exports enable row level security;
drop policy if exists "quote exports org" on quote_exports;
create policy "quote exports org" on quote_exports
  for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());

-- Files live under <org id>/<quote id>/...; everyone in the org can read, add and delete them.
drop policy if exists "quote exports files: org insert" on storage.objects;
create policy "quote exports files: org insert" on storage.objects
  for insert with check (bucket_id = 'quote-exports' and (storage.foldername(name))[1] = auth_org_id()::text);
drop policy if exists "quote exports files: org read" on storage.objects;
create policy "quote exports files: org read" on storage.objects
  for select using (bucket_id = 'quote-exports' and (storage.foldername(name))[1] = auth_org_id()::text);
drop policy if exists "quote exports files: org delete" on storage.objects;
create policy "quote exports files: org delete" on storage.objects
  for delete using (bucket_id = 'quote-exports' and (storage.foldername(name))[1] = auth_org_id()::text);
