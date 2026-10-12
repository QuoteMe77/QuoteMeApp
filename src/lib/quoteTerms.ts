// Standard wording printed on every exported quote (PDF and Word).
// Markup used in item strings:  "[[Bold lead]] rest of the line"  and  "~ italic note line".

export type TermsGroup = { heading?: string; items: string[] };
export type TermsSection = { title: string; groups: TermsGroup[] };

export const STANDARD_INCLUSIONS: string[] = [
  "Supply and installation",
  "Co-ordination of cabinetry delivery, installation, appliance integration (if applicable) and masonry works (if applicable).",
  "Pre-Production Plans (shop drawings) + 1 face-to-face plan review + 1x round of revisions*. Further revisions will incur a fee.",
  "1x On-site joinery check measure. Additional measures may incur a fee at the discretion of VICELLO.",
  "VICELLO Maintenance and Defect Period",
  "~ * Note: Production Plan Revisions are not an opportunity for design changes, they are specifically to fine tune details of existing design. Re-designs may be required to back to Studio Design Team and be removed from Production queue.",
];

export const TERMS_SECTIONS: TermsSection[] = [
  {
    title: "Joinery Terms",
    groups: [
      {
        items: [
          "Joinery quote is valid for 30 days and is subject to site measure and/or consultation.",
          "Quote does not include stone, glass, appliances, plumbing, electrical or other trades/contractors unless otherwise stated.",
          "Joins in material are to be determined by VICELLO at time of manufacture unless otherwise specified",
          "Provision Sum Definition: A provisional sum is an allowance for an item that cannot be calculated at the time of quoting and/or entering the contract. When the cost for that item/s can be calculated, it will be balanced against the Provisional Sum via a Variation and invoiced accordingly.",
          "Alternations may need to be made to Architects plans to suit VICELLO manufacturing methods.",
          "Quote includes 1x set of joinery pre-production plans with 1x round of revisions complimentary. Any additional revisions needed for change of mind, site readiness will incur an additional cost, subject to project size and time involved to make changes required",
          "Quote is based on 1x measure and 1x install. Splitting installation periods incurs additional costs subject to project size and material selections",
          "Requests for return trips to install kick faces will incur an additional cost of $550.00+GST",
          "All Blum drawer runners are white unless otherwise stated.",
          "Vicello supplies Blum drawer runners as standard, selecting the best size to suit the available cabinetry opening for proper fit and function, unless otherwise agreed in writing.",
          "Drawer opening dimensions may vary slightly between the design plans and the cabinetry installed on site, due to standard manufacturing and installation tolerances.",
          "Colour and Appliance Schedule and Joinery Production Plans must be signed off by client prior to manufacture.",
          "Timber grains are not grain matched unless otherwise stated",
          "Polyurethane paint finish is single sided on all door and drawer fronts unless otherwise stated",
          "~ Note: Dark coloured polyurethane is prone to scratches. All care but no responsibility is taken for scratches that may arise from general handling of cabinetry from factory warehouse to site and installation.",
          "If applicable Integration specialist fees are based on 1x visit, additional visits may incur a fee.",
          "The client is responsible for verifying the accuracy and proper interpretation of the quoted inclusions by VICELLO. While VICELLO will exercise due diligence in interpretation, it assumes no liability for any misinterpretations. The client agrees to indemnify and provide exemption to VICELLO from any resulting discrepancies between quotation by VICELLO and the clients interpretation of the quoted inclusions.",
        ],
      },
    ],
  },
  {
    title: "Typical Scope of Works Schedule",
    groups: [
      {
        heading: "Joinery Check measure",
        items: [
          "For projects with inhouse design, VICELLO require signed copies of VICELLO concept plans returned to schedule a joinery check measure for your project. For projects with third party joinery plans, VICELLO will endeavour to schedule a check measure as soon as possible.",
        ],
      },
      {
        heading: "Joinery Pre-Production Plans",
        items: [
          "VICELLO require 2-3 week after check measure to generate preproduction plans for approval, providing there is no outstanding documentation or information relating to site which would affect Joinery Production Plans.",
        ],
      },
      {
        heading: "Joinery Production",
        items: [
          "In order of VICELLO to place your project into PRODUCITON, we require, all outstanding questions, All Materials/Finishes/Appliances to be confirmed, client signed copies of our pre-production drawings, and stage 2 progress payments and any variations paid before the project can move into production stage.",
        ],
      },
      {
        heading: "Joinery Installation & Lead Times",
        items: [
          "Estimated 8-10 weeks – Standard Manufacturing lead time weeks from production plan sign off to installation commencement. Lead times will vary project to project, based on size, material availability, the progression of your site, progress payment and any variations have been paid, shut down periods falling within production lead time and VICELLO schedule availability at the time of engagement.",
          "8-10 weeks is an estimate ONLY based on years of industry experience for standard joinery materials such as pre-finished melamine and polyurethane finishes.",
          "For projects incorporating specialty materials — such as custom metalwork or made-to-order doors like Farmer’s Doors, lead times will increase beyond 10 weeks which is outside of Vicello’s control. These elements are often case-by-case and can carry extended timeframes that impact the broader schedule if not proactively incorporated into your build schedule.",
          "Your Project Coordinator is available to advise you on project specific lead-times related to your project once you have reached production stage.",
        ],
      },
      {
        heading: "Joinery Rectification Period",
        items: [
          "Joinery Walkthrough with VICELLO team shortly after practical completion has been reached.",
          "Rectification report to be supplied by VICELLO for all parties to review and agree upon items requiring rectification",
          "Receipt of final joinery payment and signed copy of VICELLO rectification report are required in-order to commence rectification period.",
          "4 weeks (28 days) – 28-day Defect rectification period* For defect rectifications to be carried out.",
          "Rectifications being made during the end of year period, may exceed the above timeframe due to supplier availability, project scheduling and holiday shutdowns during this period.",
          "In cases where specific materials require a lead time exceeding the rectification period, VICELLO will promptly advise of the necessary extension.",
          "Should additional items be added to this list after the rectification period has commenced, and VICELLO agrees to their inclusion, these items will require a minimum of 28 days from the date of VICELLO's agreement. Such items will not align with the timeline of the original report but will be addressed separately within the specified timeframe.",
        ],
      },
    ],
  },
  {
    title: "Progress Payment Schedule (Joinery)",
    groups: [
      {
        items: [
          "10% Deposit – Quote Acceptance & Contract Signing",
          "40% Stage 2 – Production Plan Sign off / Proceed to Manufacture",
          "45% Stage 3 – Prior to Delivery to Site / Proceed to Installation",
          "5% Stage 4 – Practical Completion Bar Minor Defects",
          "Variations - payable upon signing or with next Progress Payment unless otherwise specified.",
        ],
      },
    ],
  },
  {
    title: "Definitions",
    groups: [
      {
        items: [
          "[[“Not Included in Total” –]] This item is mentioned for reference but is not calculated in the final quoted price. It may require a separate quotation or be priced at a later stage.",
          "[[“Note only” –]] This item is listed for information purposes only. It does not affect the scope or price of the quotation.",
          "[[“Included” –]] This item is part of the quoted scope of works and is accounted for in the total price provided.",
          "[[“Excluded” –]] This item is not part of the quoted scope and is not included in the total price. It may be completed by others or require a separate agreement.",
          "[[“If Applicable” –]] This item will only apply if relevant to the final design, site conditions, or client selections. It may affect pricing if later confirmed as required.",
          "[[“By Client/Builder” –]] This item is to be supplied, installed, or coordinated by the client or builder, and is therefore not included in this quotation.",
          "[[“POA” –]] Pricing for this item is not provided at this stage and will be issued upon further clarification or request.",
          "[[“TBC” –]] Details or pricing for this item are pending final confirmation from the client, builder, or designer. TBC items may affect the quote once the item is confirmed.",
        ],
      },
    ],
  },
  {
    title: "Stone / Glass Terms",
    groups: [
      {
        items: [
          "Stone quote is valid for 30 days and is subject to site measure and final material/slab selection.",
          "Stone Payment schedules will vary depending on the stonemason engaged and your material selections. Payment schedules require a large deposit (usually 50%) due immediately to lock in slab selections with stone wholesalers, with a remittance due upon installation of stoneworks",
          "Stone is priced as a package based on total 1x measure and 1x install.",
          "Stone will be requoted at site measure and raised as a variation.",
          "Joins in material are to be determined by Stone Mason at time of manufacture unless otherwise specified",
          "Lead time for manufacture and installation of stone is minimum 15 business days from date of stone production plan approval. (Larger, more detailed projects may require extra time)",
          "~ A longer lead time may be required if nesting approval is required prior to fabrication commencing.",
          "Lead time for manufacture and installation of glass is minimum 15 business days from date of final measure & plan approval",
          "Variations are payable in full when approved or with the next progress payment.",
          "All care and no responsibility is taken for client provided stone slabs damaged during transport, manufacture, or installation.",
          "VICELLO stone sourcing – additional fee of $500.00 + GST per day (only applicable for natural stone selection)",
        ],
      },
    ],
  },
];

export const APPROVAL_TEXT = "I accept this quotation and the joinery terms above.";

export type ParsedTermLine = { kind: "bullet" | "note"; lead?: string; text: string };

export function parseTermLine(s: string): ParsedTermLine {
  if (s.startsWith("~ ")) return { kind: "note", text: s.slice(2) };
  const m = s.match(/^\[\[(.+?)\]\]\s*(.*)$/);
  if (m) return { kind: "bullet", lead: m[1], text: m[2] };
  return { kind: "bullet", text: s };
}

export function quoteAreaGroups<T extends { area: string; poa: boolean }>(items: T[]) {
  const areas = Array.from(new Set(items.map((it) => it.area || "General")));
  return areas.map((area) => {
    const rows = items.filter((it) => (it.area || "General") === area);
    return { area, included: rows.filter((r) => !r.poa), poa: rows.filter((r) => r.poa) };
  });
}
