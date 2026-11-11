-- Subcontractor / delivery costs (these are costs to the business; markup is added on top in the quote).
--   Delivery (local, and city/hard access): $900 each
--   Integrated fridge install:             $800
--   Integrated dishwasher install:         $350
-- Their whole cost is put under "Install" in the cost breakdown (and marked as not estimated).
-- Press Ctrl+A before Run. Safe to re-run. Existing saved quotes keep the rates they were saved with.

update default_price_book_items set rate = 900, cost_material = 0, cost_hardware = 0, cost_factory = 0, cost_drafting = 0, cost_studio = 0, cost_install = 900, cost_estimated = false
  where name in ('Delivery local', 'Delivery City or Hard access');
update price_book_items set rate = 900, cost_material = 0, cost_hardware = 0, cost_factory = 0, cost_drafting = 0, cost_studio = 0, cost_install = 900, cost_estimated = false
  where name in ('Delivery local', 'Delivery City or Hard access');

update default_price_book_items set rate = 800, cost_material = 0, cost_hardware = 0, cost_factory = 0, cost_drafting = 0, cost_studio = 0, cost_install = 800, cost_estimated = false
  where name = 'Integration Service - Single fridge or freezer';
update price_book_items set rate = 800, cost_material = 0, cost_hardware = 0, cost_factory = 0, cost_drafting = 0, cost_studio = 0, cost_install = 800, cost_estimated = false
  where name = 'Integration Service - Single fridge or freezer';

update default_price_book_items set rate = 350, cost_material = 0, cost_hardware = 0, cost_factory = 0, cost_drafting = 0, cost_studio = 0, cost_install = 350, cost_estimated = false
  where name = 'Integration Service - Dishwasher 60cm';
update price_book_items set rate = 350, cost_material = 0, cost_hardware = 0, cost_factory = 0, cost_drafting = 0, cost_studio = 0, cost_install = 350, cost_estimated = false
  where name = 'Integration Service - Dishwasher 60cm';
