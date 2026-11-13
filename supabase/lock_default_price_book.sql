-- The starter price book was readable by anyone (even signed-out visitors) through the API.
-- New signups are copied from it by a trusted database function (security definer), which doesn't
-- need this open policy, so close it. Safe to run more than once.
drop policy if exists "default price book readable" on default_price_book_items;
revoke all on default_price_book_items from anon;
revoke all on default_price_book_items from authenticated;
