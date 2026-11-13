import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadOrgSettings } from "@/lib/orgSettings";
import BusinessEditor from "./BusinessEditor";

export const dynamic = "force-dynamic";

export default async function BusinessSettings() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", user.id).single();
  if (!profile) redirect("/login");
  const { data: org } = await supabase.from("organizations").select("name, business_contact").eq("id", profile.org_id).single();
  const settings = await loadOrgSettings(supabase, profile.org_id);
  return <BusinessEditor name={org?.name || ""} contact={org?.business_contact || ""} settings={settings} />;
}
