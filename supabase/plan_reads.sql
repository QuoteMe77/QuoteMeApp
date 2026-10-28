-- Counts plan reads per organisation (for plan allowances and spotting heavy use). Run once; safe to re-run.
create table if not exists plan_reads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references auth.users(id),
  read_id text not null,
  dim_strings int default 0,
  created_at timestamptz not null default now()
);
create index if not exists plan_reads_org_month_idx on plan_reads(org_id, created_at);

alter table plan_reads enable row level security;
drop policy if exists "plan reads org" on plan_reads;
create policy "plan reads org" on plan_reads
  for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());
