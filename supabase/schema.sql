-- QuoteMe SaaS schema
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- after creating the project. Safe to re-run: every statement is idempotent.

-- ============================================================================
-- Organizations: one row per subscribing business.
-- ============================================================================
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Business',
  business_contact text default '',
  created_at timestamptz not null default now(),
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at timestamptz not null default (now() + interval '14 days')
);

-- ============================================================================
-- Profiles: one row per user, linking them to their organization.
-- Mirrors auth.users 1:1 (created by the trigger below on signup).
-- ============================================================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  full_name text default '',
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Default Pricing Book: the shared starter template every new organization's
-- own price_book_items gets copied from on signup. Not org-scoped, not
-- editable by customers — you maintain this list, they get a copy of it.
-- ============================================================================
create table if not exists default_price_book_items (
  id uuid primary key default gen_random_uuid(),
  calc text not null check (calc in ('LM', 'QTY', 'MISC')),
  section text not null,
  category text not null,
  name text not null,
  rate numeric(10, 2) not null,
  unit text not null,
  sort_order int not null default 0
);

-- ============================================================================
-- Each organization's own editable copy of the Pricing Book.
-- ============================================================================
create table if not exists price_book_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  calc text not null check (calc in ('LM', 'QTY', 'MISC')),
  section text not null,
  category text not null,
  name text not null,
  rate numeric(10, 2) not null,
  unit text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists price_book_items_org_idx on price_book_items(org_id);

-- ============================================================================
-- Quotes and their line items.
-- ============================================================================
create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references auth.users(id),
  business_name text default '',
  business_contact text default '',
  builder_name text default '',
  client_name text default '',
  job_address text default '',
  quote_ref text default '',
  quote_date date default current_date,
  valid_days int default 30,
  markup_pct numeric(5, 2) default 32,
  notes text default '',
  total numeric(12, 2) default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists quotes_org_idx on quotes(org_id);

create table if not exists quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  price_book_item_id uuid references price_book_items(id) on delete set null,
  name text not null,
  category text default '',
  calc text not null check (calc in ('LM', 'QTY', 'MISC')),
  unit text default '',
  rate numeric(10, 2) not null default 0,
  qty numeric(10, 3) not null default 1,
  area text default 'General',
  note text default '',
  pdf_label text default '',
  poa boolean not null default false,
  flag_label text default '',
  sort_order int not null default 0
);
create index if not exists quote_items_quote_idx on quote_items(quote_id);

-- ============================================================================
-- Row Level Security: every org only ever sees its own data.
-- ============================================================================
alter table organizations enable row level security;
alter table profiles enable row level security;
alter table price_book_items enable row level security;
alter table quotes enable row level security;
alter table quote_items enable row level security;
alter table default_price_book_items enable row level security;

-- Helper: the calling user's org_id, looked up once per statement.
create or replace function auth_org_id()
returns uuid
language sql stable
as $$
  select org_id from profiles where id = auth.uid()
$$;

drop policy if exists "org self read" on organizations;
create policy "org self read" on organizations
  for select using (id = auth_org_id());

drop policy if exists "org self update" on organizations;
create policy "org self update" on organizations
  for update using (id = auth_org_id());

drop policy if exists "profile self read" on profiles;
create policy "profile self read" on profiles
  for select using (id = auth.uid() or org_id = auth_org_id());

drop policy if exists "profile self update" on profiles;
create policy "profile self update" on profiles
  for update using (id = auth.uid());

drop policy if exists "price book org read" on price_book_items;
create policy "price book org read" on price_book_items
  for select using (org_id = auth_org_id());
drop policy if exists "price book org write" on price_book_items;
create policy "price book org write" on price_book_items
  for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());

drop policy if exists "quotes org read" on quotes;
create policy "quotes org read" on quotes
  for select using (org_id = auth_org_id());
drop policy if exists "quotes org write" on quotes;
create policy "quotes org write" on quotes
  for all using (org_id = auth_org_id()) with check (org_id = auth_org_id());

drop policy if exists "quote items via quote" on quote_items;
create policy "quote items via quote" on quote_items
  for all using (
    quote_id in (select id from quotes where org_id = auth_org_id())
  ) with check (
    quote_id in (select id from quotes where org_id = auth_org_id())
  );

drop policy if exists "default price book readable" on default_price_book_items;
create policy "default price book readable" on default_price_book_items
  for select using (true);

-- ============================================================================
-- New-signup trigger: creates the organization + profile, and seeds the
-- organization's price_book_items from default_price_book_items.
-- ============================================================================
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org_id uuid;
begin
  insert into organizations (name) values (coalesce(new.raw_user_meta_data->>'business_name', 'My Business'))
    returning id into new_org_id;

  insert into profiles (id, org_id, full_name, role)
    values (new.id, new_org_id, coalesce(new.raw_user_meta_data->>'full_name', ''), 'owner');

  insert into price_book_items (org_id, calc, section, category, name, rate, unit, sort_order)
    select new_org_id, calc, section, category, name, rate, unit, sort_order
    from default_price_book_items;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();
