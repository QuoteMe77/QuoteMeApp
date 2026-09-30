import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import QuoteBuilder from "@/components/QuoteBuilder";

export default async function NewQuotePage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id, full_name")
    .eq("id", user.id)
    .single();
  if (!profile) redirect("/login");

  const { data: org } = await supabase
    .from("organizations")
    .select("name, business_contact")
    .eq("id", profile.org_id)
    .single();

  const { data: priceBook } = await supabase
    .from("price_book_items")
    .select("id, calc, section, category, name, rate, unit, sort_order")
    .order("sort_order", { ascending: true });

  return (
    <QuoteBuilder
      priceBook={priceBook || []}
      quote={null}
      items={[]}
      defaultBusinessName={org?.name || ""}
      defaultBusinessContact={org?.business_contact || ""}
      defaultBuilderName={profile.full_name || ""}
    />
  );
}
