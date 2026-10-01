-- Resyncs every existing organization's price_book_items from the current
-- default_price_book_items template.
--
-- Why this is needed: default_price_book_items is only ever copied into an
-- org's own price_book_items once, by the handle_new_user() trigger, at the
-- moment that org signs up. Re-running seed_price_book.sql updates the
-- shared template, but it does NOT retroactively update any organization
-- that already exists — their price_book_items rows stay exactly as they
-- were on the day they signed up. This script is the one-time catch-up step
-- for orgs that already exist.
--
-- IMPORTANT — read before running:
-- 1. Run seed_price_book.sql FIRST, so default_price_book_items holds the
--    corrected, up-to-date catalog before this script copies from it.
-- 2. This DELETES every existing org's price_book_items rows and replaces
--    them with a fresh copy of the current default_price_book_items. Any
--    item an org added or edited by hand directly in price_book_items
--    (rather than via default_price_book_items) will be lost.
-- 3. quote_items.price_book_item_id has `on delete set null` — every
--    existing quote's line items will have that link cleared (set to
--    null) by this delete. This is NOT destructive to the quote itself:
--    each quote_item already stores its own name, rate, category, etc.
--    directly, so saved/sent quotes keep displaying exactly as they did.
--    What's lost is only the live link back to "which price book item was
--    this line originally matched to" — so re-opening an old quote to
--    re-match a line against the price book will show it as unmatched,
--    the same as if it had been entered as a custom line from the start.
-- 4. This affects ALL organizations, including any test/duplicate
--    "Vicello" orgs still in the database — clean those up first if you
--    don't want them resynced too.

begin;

delete from price_book_items;

insert into price_book_items (org_id, calc, section, category, name, rate, unit, sort_order)
select o.id, d.calc, d.section, d.category, d.name, d.rate, d.unit, d.sort_order
from organizations o
cross join default_price_book_items d;

commit;
