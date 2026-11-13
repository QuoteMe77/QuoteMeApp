import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadPriceBook } from "@/lib/loadPriceBook";
import QuoteBuilder from "@/components/QuoteBuilder";
import { loadTerms } from "@/lib/loadTerms";
import { loadOrgSettings } from "@/lib/orgSettings";

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

  // For a variation: the original quote's lines (plus earlier variations) so updated plans can be compared with them.
  let baseItems: unknown[] = [];
  if (quote.kind === "variation" && quote.project_id) {
    const { data: siblings } = await supabase.from("quotes").select("id, kind, rev, status, variation_no").eq("project_id", quote.project_id);
    const quotesOnly = (siblings || []).filter((q: { kind?: string }) => (q.kind || "quote") === "quote");
    const accepted = quotesOnly.filter((q: { status?: string }) => q.status === "accepted" || q.status === "approved");
    const pool = accepted.length > 0 ? accepted : quotesOnly;
    const baseQuote = pool.sort((x: { rev: number }, y: { rev: number }) => (y.rev || 1) - (x.rev || 1))[0];
    const earlier = (siblings || []).filter((q: { kind?: string; variation_no?: number; id: string }) => q.kind === "variation" && q.id !== quote.id && (q.variation_no || 0) < (quote.variation_no || 0));
    const ids = [baseQuote?.id, ...earlier.map((q: { id: string }) => q.id)].filter(Boolean) as string[];
    if (ids.length > 0) {
      const { data: rows } = await supabase
        .from("quote_items")
        .select("area, name, pdf_label, qty, unit, rate, calc, category, note, price_book_item_id, poa")
        .in("quote_id", ids);
      baseItems = rows || [];
    }
  }

  const priceBook = await loadPriceBook(supabase);
  const settings = await loadOrgSettings(supabase, profile.org_id);
  const { terms } = await loadTerms(supabase, profile.org_id, quote.business_name || "");

  return (
    <QuoteBuilder
      priceBook={priceBook || []}
      terms={terms}
      settings={settings}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseItems={baseItems as any}
      quote={quote}
      items={items || []}
      defaultBusinessName={quote.business_name || ""}
      defaultBusinessContact={quote.business_contact || ""}
      defaultBuilderName={quote.builder_name || profile.full_name || ""}
    />
  );
}
