import { createClient } from "@/lib/supabase/server";

export type OrgSettings = {
  abn: string;
  address: string;
  logo_data: string | null;
  logo_ratio: number | null;
  deposit_pct: number | null;
  bank_account_name: string;
  bank_name: string;
  bank_bsb: string;
  bank_account_no: string;
  default_markup_pct: number | null;
  default_valid_days: number | null;
  setup_completed_at: string | null;
};

export const EMPTY_SETTINGS: OrgSettings = {
  abn: "",
  address: "",
  logo_data: null,
  logo_ratio: null,
  deposit_pct: null,
  bank_account_name: "",
  bank_name: "",
  bank_bsb: "",
  bank_account_no: "",
  default_markup_pct: null,
  default_valid_days: null,
  setup_completed_at: null,
};

// Business details for the signed-in shop; empty when nothing has been saved (or the table doesn't exist yet).
export async function loadOrgSettings(supabase: ReturnType<typeof createClient>, orgId: string): Promise<OrgSettings> {
  try {
    const { data, error } = await supabase.from("org_settings").select("*").eq("org_id", orgId).maybeSingle();
    if (!error && data) {
      const d = data as Record<string, unknown>;
      return {
        abn: (d.abn as string) || "",
        address: (d.address as string) || "",
        logo_data: (d.logo_data as string) || null,
        logo_ratio: d.logo_ratio === null || d.logo_ratio === undefined ? null : Number(d.logo_ratio),
        deposit_pct: d.deposit_pct === null || d.deposit_pct === undefined ? null : Number(d.deposit_pct),
        bank_account_name: (d.bank_account_name as string) || "",
        bank_name: (d.bank_name as string) || "",
        bank_bsb: (d.bank_bsb as string) || "",
        bank_account_no: (d.bank_account_no as string) || "",
        default_markup_pct: d.default_markup_pct === null || d.default_markup_pct === undefined ? null : Number(d.default_markup_pct),
        default_valid_days: d.default_valid_days === null || d.default_valid_days === undefined ? null : Number(d.default_valid_days),
        setup_completed_at: (d.setup_completed_at as string) || null,
      };
    }
  } catch {
    /* table not created yet */
  }
  return EMPTY_SETTINGS;
}
