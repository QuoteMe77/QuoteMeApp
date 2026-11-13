import { createClient } from "@/lib/supabase/server";
import { loadPriceBook } from "@/lib/loadPriceBook";
import PriceBookEditor from "./PriceBookEditor";

export const dynamic = "force-dynamic";

export default async function PriceBookSettings() {
  const supabase = createClient();
  const items = await loadPriceBook(supabase);
  return <PriceBookEditor items={items} />;
}
