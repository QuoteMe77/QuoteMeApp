-- Each shop's business details: logo, ABN, deposit, bank details and quote defaults.
-- Safe to run more than once.
create table if not exists org_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  abn text default '',
  address text default '',
  logo_data text,
  logo_ratio numeric,
  deposit_pct numeric,
  bank_account_name text default '',
  bank_name text default '',
  bank_bsb text default '',
  bank_account_no text default '',
  default_markup_pct numeric,
  default_valid_days int,
  setup_completed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table org_settings enable row level security;
drop policy if exists "org settings read" on org_settings;
create policy "org settings read" on org_settings for select
  using (org_id in (select org_id from profiles where id = auth.uid()));
drop policy if exists "org settings write" on org_settings;
create policy "org settings write" on org_settings for all
  using (org_id in (select org_id from profiles where id = auth.uid()))
  with check (org_id in (select org_id from profiles where id = auth.uid()));
