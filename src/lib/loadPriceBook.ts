import { createClient } from "@/lib/supabase/server";

const BASE = "id, calc, section, category, name, rate, unit, sort_order";
const COSTS = ", cost_material, cost_hardware, cost_factory, cost_drafting, cost_studio, cost_install";

// Loads the org's price book. The cost-breakdown columns only exist once cost_breakdown.sql
// (and cost_breakdown_estimates.sql) have been run, so fall back step by step to what exists.
export async function loadPriceBook(supabase: ReturnType<typeof createClient>): Promise<any[]> {
  for (const cols of [BASE + COSTS + ", cost_estimated", BASE + COSTS, BASE]) {
    const r = await supabase.from("price_book_items").select(cols).order("sort_order", { ascending: true });
    if (!r.error) return (r.data as unknown as any[]) || [];
  }
  return [];
}
