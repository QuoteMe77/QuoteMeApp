"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type QuoteItemInput = {
  id?: string; // present when editing an existing line item, absent for new ones
  price_book_item_id: string | null;
  name: string;
  category: string;
  calc: "LM" | "QTY" | "MISC";
  unit: string;
  rate: number;
  qty: number;
  area: string;
  note: string;
  pdf_label: string;
  poa: boolean;
  flag_label: string;
  sort_order: number;
};

export type QuoteMetaInput = {
  business_name: string;
  business_contact: string;
  builder_name: string;
  client_name: string;
  job_address: string;
  quote_ref: string;
  quote_date: string;
  valid_days: number;
  markup_pct: number;
  notes: string;
};

/**
 * Creates or updates a quote and replaces its full set of line items in one
 * transaction-like sequence. Called from the client builder on every Save.
 * Returns the quote id so a "new quote" save can redirect to its edit URL.
 */
export async function saveQuote(
  quoteId: string | null,
  meta: QuoteMetaInput,
  items: QuoteItemInput[],
  total: number
): Promise<{ id: string } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", user.id).single();
  if (!profile) return { error: "No organization found for this user." };

  let id = quoteId;

  if (id) {
    const { error } = await supabase
      .from("quotes")
      .update({ ...meta, total, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("org_id", profile.org_id);
    if (error) return { error: error.message };

    // Simplest correct approach: replace all line items on every save.
    // Quotes are edited as a whole in one sitting, so this avoids diffing.
    const { error: delErr } = await supabase.from("quote_items").delete().eq("quote_id", id);
    if (delErr) return { error: delErr.message };
  } else {
    const { data: inserted, error } = await supabase
      .from("quotes")
      .insert({ ...meta, total, org_id: profile.org_id, created_by: user.id })
      .select("id")
      .single();
    if (error || !inserted) return { error: error?.message || "Could not create quote." };
    id = inserted.id;
  }

  if (items.length > 0) {
    const rows = items.map((item, index) => ({
      quote_id: id,
      price_book_item_id: item.price_book_item_id,
      name: item.name,
      category: item.category,
      calc: item.calc,
      unit: item.unit,
      rate: item.rate,
      qty: item.qty,
      area: item.area || "General",
      note: item.note,
      pdf_label: item.pdf_label,
      poa: item.poa,
      flag_label: item.flag_label,
      sort_order: index,
    }));
    const { error: itemsErr } = await supabase.from("quote_items").insert(rows);
    if (itemsErr) return { error: itemsErr.message };
  }

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/quotes/${id}`);
  return { id: id! };
}

export async function deleteQuote(quoteId: string): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", user.id).single();
  if (!profile) return { error: "No organization found for this user." };

  const { error } = await supabase.from("quotes").delete().eq("id", quoteId).eq("org_id", profile.org_id);
  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteQuoteAndRedirect(quoteId: string) {
  await deleteQuote(quoteId);
  redirect("/dashboard");
}
