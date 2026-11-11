-- Keeps the plans each quote was read from inside its project, and remembers where
-- on the plan every quote line came from. Run once in the Supabase SQL editor
-- (press Ctrl+A first). Safe to re-run. Does not delete anything.

insert into storage.buckets (id, name, public)
values ('project-plans', 'project-plans', false)
on conflict (id) do nothing;

create table if not exists project_plans (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  quote_id uuid references quotes(id) on delete set null,
  filename text not null,
  storage_path text not null,
  size_bytes bigint default 0,
  created_at timestamptz not null default now()
);
create index if not exists project_plans_project_idx on project_plans(project_id);

alter table project_plans enable row level security;
drop policy if exists "project plans org" on project_plans;
create policy "project plans org" on project_plans
  for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());

drop policy if exists "project plans files: org insert" on storage.objects;
create policy "project plans files: org insert" on storage.objects
  for insert with check (bucket_id = 'project-plans' and (storage.foldername(name))[1] = auth_org_id()::text);
drop policy if exists "project plans files: org read" on storage.objects;
create policy "project plans files: org read" on storage.objects
  for select using (bucket_id = 'project-plans' and (storage.foldername(name))[1] = auth_org_id()::text);
drop policy if exists "project plans files: org update" on storage.objects;
create policy "project plans files: org update" on storage.objects
  for update using (bucket_id = 'project-plans' and (storage.foldername(name))[1] = auth_org_id()::text);
drop policy if exists "project plans files: org delete" on storage.objects;
create policy "project plans files: org delete" on storage.objects
  for delete using (bucket_id = 'project-plans' and (storage.foldername(name))[1] = auth_org_id()::text);

alter table quote_items add column if not exists plan_id uuid;
alter table quote_items add column if not exists regions jsonb;
