import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadTerms } from "@/lib/loadTerms";
import TermsEditor from "./TermsEditor";

export const dynamic = "force-dynamic";

export default async function TermsSettings() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", user.id).single();
  if (!profile) redirect("/login");
  const { data: org } = await supabase.from("organizations").select("name").eq("id", profile.org_id).single();
  const { terms, saved } = await loadTerms(supabase, profile.org_id, org?.name || "");
  return <TermsEditor initial={terms} saved={saved} />;
}
