-- Lets each quote carry a name you choose (shown in My quotes). Run once; safe to re-run.
alter table quotes add column if not exists quote_name text default '';
