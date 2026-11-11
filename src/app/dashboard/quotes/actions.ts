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
  plan_id?: string | null;
  regions?: { page: number; bbox: [number, number, number, number] }[] | null;
  sort_order: number;
};

export type QuoteMetaInput = {
  quote_name?: string;
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

  // Accepted quotes / approved variations are locked — changes go in a variation (or reopen it first).
  if (id) {
    const { data: cur } = await supabase.from("quotes").select("status").eq("id", id).eq("org_id", profile.org_id).maybeSingle();
    const st = (cur as { status?: string } | null)?.status;
    if (st === "accepted" || st === "approved") {
      return { error: "This is accepted/approved and locked. Create a variation for changes, or reopen it from the project page." };
    }
  }

  // quote_name needs the quote_name.sql column; until that has been run, save without it.
  const { quote_name: _qn, ...metaNoName } = meta;
  void _qn;
  const isNameColumnError = (m?: string) => !!m && /quote_name/i.test(m);

  if (id) {
    let { error } = await supabase
      .from("quotes")
      .update({ ...meta, total, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("org_id", profile.org_id);
    if (error && isNameColumnError(error.message)) {
      ({ error } = await supabase
        .from("quotes")
        .update({ ...metaNoName, total, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("org_id", profile.org_id));
    }
    if (error) return { error: error.message };

    // Simplest correct approach: replace all line items on every save.
    // Quotes are edited as a whole in one sitting, so this avoids diffing.
    const { error: delErr } = await supabase.from("quote_items").delete().eq("quote_id", id);
    if (delErr) return { error: delErr.message };
  } else {
    // Every new quote gets its own project folder (needs projects.sql; skipped until it has been run).
    let projectId: string | null = null;
    {
      const pr = await supabase
        .from("projects")
        .insert({ org_id: profile.org_id, name: meta.quote_name || meta.client_name || meta.quote_ref || "Project" })
        .select("id")
        .single();
      if (!pr.error && pr.data) projectId = pr.data.id;
    }
    const extra = projectId ? { project_id: projectId } : {};
    let res = await supabase
      .from("quotes")
      .insert({ ...meta, ...extra, total, org_id: profile.org_id, created_by: user.id })
      .select("id")
      .single();
    if (res.error && isNameColumnError(res.error.message)) {
      res = await supabase
        .from("quotes")
        .insert({ ...metaNoName, ...extra, total, org_id: profile.org_id, created_by: user.id })
        .select("id")
        .single();
    }
    if (res.error || !res.data) return { error: res.error?.message || "Could not create quote." };
    id = res.data.id;
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
      plan_id: item.plan_id ?? null,
      regions: item.regions ?? null,
    }));
    let { error: itemsErr } = await supabase.from("quote_items").insert(rows);
    // plan_id / regions need plans.sql; until it has been run, save without them.
    if (itemsErr && /plan_id|regions/i.test(itemsErr.message)) {
      const plain = rows.map((r) => {
        const { plan_id: _p, regions: _r, ...rest } = r;
        void _p; void _r;
        return rest;
      });
      ({ error: itemsErr } = await supabase.from("quote_items").insert(plain));
    }
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

// ---------------------------------------------------------------------------
// Project folders: revisions, variations, status.
// ---------------------------------------------------------------------------
type AuthOk = {
  error?: undefined;
  supabase: ReturnType<typeof createClient>;
  user: { id: string };
  orgId: string;
};
type AuthFail = { error: string };

async function authOrg(): Promise<AuthOk | AuthFail> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", user.id).single();
  if (!profile) return { error: "No organization found for this user." };
  return { supabase, user, orgId: profile.org_id as string };
}

const SETUP_MSG = "Project folders need projects.sql to be run in Supabase first.";

// Copies the project's current quote into a new revision (Rev B, C…), same items, ready to edit.
export async function createRevision(quoteId: string): Promise<{ id: string } | { error: string }> {
  const a = await authOrg();
  if (a.error !== undefined) return { error: a.error };
  const { supabase, user, orgId } = a;
  const { data: src } = await supabase.from("quotes").select("*").eq("id", quoteId).eq("org_id", orgId).single();
  if (!src || !("project_id" in src) || !src.project_id) return { error: SETUP_MSG };
  const { data: sibs } = await supabase.from("quotes").select("rev").eq("project_id", src.project_id).eq("kind", "quote");
  const nextRev = Math.max(0, ...(sibs || []).map((r: { rev: number }) => r.rev || 1)) + 1;
  const { id: _id, created_at: _c, updated_at: _u, approved_at: _ap, ...rest } = src as Record<string, unknown>;
  void _id; void _c; void _u; void _ap;
  const { data: ins, error } = await supabase
    .from("quotes")
    .insert({ ...rest, rev: nextRev, status: "draft", kind: "quote", created_by: user.id, quote_date: new Date().toISOString().slice(0, 10) })
    .select("id")
    .single();
  if (error || !ins) return { error: error?.message || "Could not create the revision." };
  const { data: items } = await supabase.from("quote_items").select("*").eq("quote_id", quoteId).order("sort_order", { ascending: true });
  if (items && items.length > 0) {
    const rows = items.map((it: Record<string, unknown>) => {
      const { id: _iid, quote_id: _q, ...r } = it;
      void _iid; void _q;
      return { ...r, quote_id: ins.id };
    });
    const { error: ie } = await supabase.from("quote_items").insert(rows);
    if (ie) return { error: ie.message };
  }
  revalidatePath(`/dashboard/projects/${src.project_id}`);
  revalidatePath("/dashboard");
  return { id: ins.id };
}

// Starts an empty variation (V1, V2…) carrying the client, site and markup from the project's current quote.
export async function createVariation(projectId: string): Promise<{ id: string } | { error: string }> {
  const a = await authOrg();
  if (a.error !== undefined) return { error: a.error };
  const { supabase, user, orgId } = a;
  const { data: all } = await supabase.from("quotes").select("*").eq("project_id", projectId).eq("org_id", orgId);
  if (!all || all.length === 0) return { error: SETUP_MSG };
  const quotes = all.filter((q: { kind?: string }) => (q.kind || "quote") === "quote").sort((x: { rev: number }, y: { rev: number }) => (y.rev || 1) - (x.rev || 1));
  const base = quotes[0] || all[0];
  const nextNo = Math.max(0, ...all.filter((q: { kind?: string }) => q.kind === "variation").map((q: { variation_no?: number }) => q.variation_no || 0)) + 1;
  const { data: ins, error } = await supabase
    .from("quotes")
    .insert({
      org_id: orgId,
      created_by: user.id,
      project_id: projectId,
      kind: "variation",
      variation_no: nextNo,
      rev: 1,
      status: "draft",
      business_name: base.business_name,
      business_contact: base.business_contact,
      builder_name: base.builder_name,
      client_name: base.client_name,
      job_address: base.job_address,
      quote_ref: `${base.quote_ref || "Quote"}-V${nextNo}`,
      valid_days: base.valid_days,
      markup_pct: base.markup_pct,
      notes: "",
      total: 0,
    })
    .select("id")
    .single();
  if (error || !ins) return { error: error?.message || "Could not create the variation." };
  revalidatePath(`/dashboard/projects/${projectId}`);
  revalidatePath("/dashboard");
  return { id: ins.id };
}

export async function setQuoteStatus(quoteId: string, status: string): Promise<{ ok: true } | { error: string }> {
  const allowed = ["draft", "sent", "accepted", "approved", "declined"];
  if (!allowed.includes(status)) return { error: "Unknown status." };
  const a = await authOrg();
  if (a.error !== undefined) return { error: a.error };
  const { supabase, orgId } = a;
  const done = status === "accepted" || status === "approved";
  const { data, error } = await supabase
    .from("quotes")
    .update({ status, approved_at: done ? new Date().toISOString() : null })
    .eq("id", quoteId)
    .eq("org_id", orgId)
    .select("project_id")
    .single();
  if (error) return { error: error.message };
  if (data?.project_id) revalidatePath(`/dashboard/projects/${data.project_id}`);
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteProject(projectId: string): Promise<{ ok: true } | { error: string }> {
  const a = await authOrg();
  if (a.error !== undefined) return { error: a.error };
  const { supabase, orgId } = a;
  const { error } = await supabase.from("projects").delete().eq("id", projectId).eq("org_id", orgId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard");
  return { ok: true };
}
