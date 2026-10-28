-- Optional monthly plan-read allowance per organisation. Empty (null) = unlimited.
-- Run once; safe to re-run. Set a customer's allowance with, for example:
--   update organizations set monthly_read_limit = 15 where name = 'Customer Name';
alter table organizations add column if not exists monthly_read_limit int;
