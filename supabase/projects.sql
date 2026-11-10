-- Project folders: one home per job for the quote, its revisions and its variations.
-- Run once in the Supabase SQL editor. Safe to re-run. Does not delete anything.
begin;

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text default '',
  created_at timestamptz not null default now()
);
create index if not exists projects_org_idx on projects(org_id);

alter table projects enable row level security;
drop policy if exists "projects org" on projects;
create policy "projects org" on projects
  for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());

alter table quotes add column if not exists project_id uuid references projects(id) on delete cascade;
alter table quotes add column if not exists kind text not null default 'quote';
alter table quotes add column if not exists rev int not null default 1;
alter table quotes add column if not exists variation_no int;
alter table quotes add column if not exists status text not null default 'draft';
alter table quotes add column if not exists approved_at timestamptz;
create index if not exists quotes_project_idx on quotes(project_id);

-- Every existing quote becomes its own project (first run only).
update quotes set project_id = gen_random_uuid() where project_id is null;
insert into projects (id, org_id, name, created_at)
  select q.project_id, q.org_id,
         coalesce(nullif(q.quote_name, ''), nullif(q.client_name, ''), nullif(q.quote_ref, ''), 'Project'),
         q.created_at
  from quotes q
  where not exists (select 1 from projects p where p.id = q.project_id);

commit;
