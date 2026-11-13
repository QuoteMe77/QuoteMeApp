-- Each shop's own editable terms & conditions (printed on the PDF and Word quote).
-- Safe to run more than once.
create table if not exists org_terms (
  org_id uuid primary key references organizations(id) on delete cascade,
  inclusions jsonb not null default '[]'::jsonb,
  sections jsonb not null default '[]'::jsonb,
  approval_text text not null default 'I accept this quotation and the joinery terms above.',
  updated_at timestamptz not null default now()
);
alter table org_terms enable row level security;
drop policy if exists "org terms read" on org_terms;
create policy "org terms read" on org_terms for select
  using (org_id in (select org_id from profiles where id = auth.uid()));
drop policy if exists "org terms write" on org_terms;
create policy "org terms write" on org_terms for all
  using (org_id in (select org_id from profiles where id = auth.uid()))
  with check (org_id in (select org_id from profiles where id = auth.uid()));
