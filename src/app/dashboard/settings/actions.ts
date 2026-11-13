"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type Result = { ok: true; id?: string } | { error: string };

const SPLITS = ["cost_material", "cost_hardware", "cost_factory", "cost_drafting", "cost_studio", "cost_install"] as const;

async function orgContext() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", user.id).single();
  if (!profile) return null;
  return { supabase, orgId: profile.org_id as string };
}

const num = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

// Edits one price book row. `patch` may hold name, unit, section, category, rate and the six cost_* splits.
export async function updatePriceBookItem(id: string, patch: Record<string, unknown>): Promise<Result> {
  const ctx = await orgContext();
  if (!ctx) return { error: "Not signed in." };
  const clean: Record<string, unknown> = {};
  for (const k of ["name", "unit", "section", "category"]) {
    if (typeof patch[k] === "string") clean[k] = (patch[k] as string).trim();
  }
  if ("rate" in patch) {
    const r = num(patch.rate);
    if (r === null || r < 0) return { error: "Rate must be a number." };
    clean.rate = r;
  }
  let touchedSplit = false;
  for (const k of SPLITS) {
    if (k in patch) {
      clean[k] = num(patch[k]);
      touchedSplit = true;
    }
  }
  if (Object.keys(clean).length === 0) return { ok: true };
  if (touchedSplit) {
    // Once someone types the split themselves it's no longer an estimate.
    const withFlag = await ctx.supabase.from("price_book_items").update({ ...clean, cost_estimated: false }).eq("id", id).eq("org_id", ctx.orgId);
    if (!withFlag.error) {
      revalidatePath("/dashboard/settings/price-book");
      return { ok: true };
    }
  }
  const { error } = await ctx.supabase.from("price_book_items").update(clean).eq("id", id).eq("org_id", ctx.orgId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/settings/price-book");
  return { ok: true };
}

export async function addPriceBookItem(input: {
  calc: "LM" | "QTY" | "MISC";
  section: string;
  category: string;
  name: string;
  unit: string;
  rate: number;
  splits?: Record<string, number | null>;
}): Promise<Result> {
  const ctx = await orgContext();
  if (!ctx) return { error: "Not signed in." };
  const name = input.name.trim();
  if (!name) return { error: "Give the item a name." };
  const rate = num(input.rate);
  if (rate === null || rate < 0) return { error: "Rate must be a number." };
  if (!["LM", "QTY", "MISC"].includes(input.calc)) return { error: "Pick how it's priced." };
  const { data: last } = await ctx.supabase
    .from("price_book_items")
    .select("sort_order")
    .eq("org_id", ctx.orgId)
    .order("sort_order", { ascending: false })
    .limit(1);
  const sort = ((last && last[0]?.sort_order) || 0) + 1;
  const row: Record<string, unknown> = {
    org_id: ctx.orgId,
    calc: input.calc,
    section: input.section.trim() || "General",
    category: input.category.trim() || "General",
    name,
    unit: input.unit.trim() || (input.calc === "LM" ? "m" : "ea"),
    rate,
    sort_order: sort,
  };
  const hasSplit = input.splits && SPLITS.some((k) => num(input.splits![k]) !== null);
  if (hasSplit) for (const k of SPLITS) row[k] = num(input.splits![k]);
  let res = await ctx.supabase.from("price_book_items").insert(hasSplit ? { ...row, cost_estimated: false } : row).select("id").single();
  if (res.error && hasSplit) res = await ctx.supabase.from("price_book_items").insert(row).select("id").single();
  if (res.error) return { error: res.error.message };
  revalidatePath("/dashboard/settings/price-book");
  return { ok: true, id: res.data?.id as string };
}

export async function deletePriceBookItem(id: string): Promise<Result> {
  const ctx = await orgContext();
  if (!ctx) return { error: "Not signed in." };
  const { error } = await ctx.supabase.from("price_book_items").delete().eq("id", id).eq("org_id", ctx.orgId);
  if (error) return { error: error.message };
  revalidatePath("/dashboard/settings/price-book");
  return { ok: true };
}

// Raises (or lowers, with a negative %) every rate and its department split by the same percentage.
export async function bulkAdjustRates(pct: number, section?: string): Promise<Result & { changed?: number }> {
  const ctx = await orgContext();
  if (!ctx) return { error: "Not signed in." };
  if (!Number.isFinite(pct) || pct <= -90 || pct > 200) return { error: "Enter a percentage between -90 and 200." };
  let q = ctx.supabase.from("price_book_items").select("*").eq("org_id", ctx.orgId);
  if (section) q = q.eq("section", section);
  const { data, error } = await q;
  if (error) return { error: error.message };
  const f = 1 + pct / 100;
  let changed = 0;
  for (const r of data || []) {
    const patch: Record<string, number | null> = { rate: Math.round(Number(r.rate) * f * 100) / 100 };
    for (const k of SPLITS) if (r[k] !== null && r[k] !== undefined) patch[k] = Math.round(Number(r[k]) * f * 100) / 100;
    const u = await ctx.supabase.from("price_book_items").update(patch).eq("id", r.id).eq("org_id", ctx.orgId);
    if (u.error) return { error: u.error.message };
    changed++;
  }
  revalidatePath("/dashboard/settings/price-book");
  return { ok: true, changed };
}
