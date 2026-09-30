import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import QuoteBuilder from "@/components/QuoteBuilder";

export default async function EditQuotePage({ params }: { params: { id: string } }) {
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

  const { data: quote } = await supabase.from("quotes").select("*").eq("id", params.id).single();
  if (!quote) notFound();

  const { data: items } = await supabase
    .from("quote_items")
    .select("*")
    .eq("quote_id", params.id)
    .order("sort_order", { ascending: true });

  const { data: priceBook } = await supabase
    .from("price_book_items")
    .select("id, calc, section, category, name, rate, unit, sort_order")
    .order("sort_order", { ascending: true });

  return (
    <QuoteBuilder
      priceBook={priceBook || []}
      quote={quote}
      items={items || []}
      defaultBusinessName={quote.business_name || ""}
      defaultBusinessContact={quote.business_contact || ""}
      defaultBuilderName={quote.builder_name || profile.full_name || ""}
    />
  );
}
