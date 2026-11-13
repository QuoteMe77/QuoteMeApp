import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadPriceBook } from "@/lib/loadPriceBook";
import QuoteBuilder from "@/components/QuoteBuilder";
import { loadTerms } from "@/lib/loadTerms";
import { loadOrgSettings } from "@/lib/orgSettings";

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

  const priceBook = await loadPriceBook(supabase);
  const settings = await loadOrgSettings(supabase, profile.org_id);
  const { terms } = await loadTerms(supabase, profile.org_id, org?.name || "");

  return (
    <QuoteBuilder
      priceBook={priceBook || []}
      terms={terms}
      settings={settings}
      quote={null}
      items={[]}
      defaultBusinessName={org?.name || ""}
      defaultBusinessContact={org?.business_contact || ""}
      defaultBuilderName={profile.full_name || ""}
    />
  );
}
