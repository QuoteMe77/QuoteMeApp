-- Fixes "stack depth limit exceeded" on profile/org lookups.
--
-- auth_org_id() queries `profiles`, but that query was itself subject to
-- the `profiles` RLS policy below, which calls auth_org_id() again — an
-- infinite loop. Marking the function `security definer` makes its internal
-- query run with elevated privileges, bypassing RLS for that one lookup and
-- breaking the recursion. It's still safe: the function only ever returns
-- the org_id belonging to whichever user is calling it (auth.uid()).
--
-- Safe to re-run.

create or replace function auth_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from profiles where id = auth.uid()
$$;
