import { createClient } from "@/lib/supabase/server";
import { defaultTermsFor, type QuoteTerms, type TermsSection } from "@/lib/quoteTerms";

// The shop's saved terms, or the standard wording (with the shop's name) when it hasn't edited them
// yet — or when the org_terms table hasn't been created.
export async function loadTerms(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  businessName: string
): Promise<{ terms: QuoteTerms; saved: boolean }> {
  try {
    const { data, error } = await supabase.from("org_terms").select("inclusions, sections, approval_text").eq("org_id", orgId).maybeSingle();
    if (!error && data) {
      return {
        saved: true,
        terms: {
          inclusions: (data.inclusions as string[]) || [],
          sections: (data.sections as TermsSection[]) || [],
          approvalText: (data.approval_text as string) || defaultTermsFor(businessName).approvalText,
        },
      };
    }
  } catch {
    /* fall through to the default */
  }
  return { saved: false, terms: defaultTermsFor(businessName) };
}
