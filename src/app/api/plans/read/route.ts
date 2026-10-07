import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { REFERENCE_EXAMPLES } from "./referenceExamples";

export const runtime = "nodejs";
// Raised from 60s: extended thinking (added below) gives the model time to
// reason through a multi-page plan before answering, which adds real
// latency on top of what was already a slow vision+PDF call. If this
// project is on Vercel's Hobby plan, 60s may be the hard ceiling regardless
// of this setting — worth checking if reads start timing out.
export const maxDuration = 120;

const PLAN_PROMPT = `You are an experienced joinery estimator reviewing a construction document set (floor plans, elevations, joinery/cabinetry detail sheets, and — often within the same document — a finishes, fixtures & equipment (FFE) schedule or joinery finishes/hardware page) for a fit-out of any room type (kitchen, pantry, laundry, bathroom, wardrobe, and so on — don't assume kitchen). Read every page provided. The finishes schedule is the source of truth for materials/hardware — use it to resolve coded references (e.g. "L1", "PC1") and fill in finish/drawer brand even when nothing is tagged on the drawing itself — but never quote line items from the schedule directly; it only informs items found on the actual drawings.

== WHAT COUNTS AS SCOPE ==
Identify every distinct piece of joinery scope, not just cabinet runs: base/wall/tall/pantry cabinets, end panels, bulkheads, shelving, vanities, wardrobes, AND discrete fittings a joinery shop supplies/installs (laundry chutes, hampers, hanging rods, ironing boards, sink installation, LED strips, shadowline reveals called up as their own item, and similar). Don't skip the latter just because they aren't a run of cabinetry.

Exclusions:
- Handles are never their own item (already in the cabinet run's LM rate) — leave them out entirely, even if a style/code is specified.
- Anything supplied/installed by someone other than the joinery shop (stone benchtops, splashbacks, tap/mixer, "by other"/client-supplied/existing appliances) is not priced scope. Combine ALL of these into ONE item for the whole job: name "Stone benchtop / Splashback / Appliances — by others", calc "MISC", qty 1, unit "item". Never list them individually.
- An INTEGRATED APPLIANCE (integrated fridge, dishwasher, etc.) is different from a "by other" appliance: the joinery shop builds its housing, and it ALWAYS gets its own separate QTY item (e.g. "Integrated dishwasher", calc "QTY", qty 1) ON TOP of the cabinetry lines — confirmed by the business owner against a real job. How the surrounding LM is measured depends on where the appliance sits (decide per appliance, by looking at its column on the elevation):
  - BENCH-HEIGHT appliance inside a base band (a dishwasher or dish drawer sitting under the benchtop in a row of base cabinets): its width stays INSIDE that base run's LM, exactly as if a plain base cabinet stood there. Do not subtract it. (Sinks, bins and hampers are treated the same way.)
  - FLOOR-TO-HEIGHT appliance (an integrated fridge or freezer, or any appliance that fills the lower part of its own full-height column): the WHOLE column — the appliance section AND any doors/shelving above it — counts as TALL cabinetry (cabinet_type "tall", calc "LM") at that column's full printed width. It is never base LM and never wall LM, even though the cabinetry above the appliance looks like wall doors. The appliance itself is ALSO its own separate QTY item on top (e.g. "Integrated fridge", qty 1). Add this column's width to the same "tall" item as any other tall column on that wall.
  - Two appliance gaps side by side are still TWO separate QTY items, each with its own label and width — never one combined item. A combined width in a note (two widths added into one appliance) is the sign you merged them; split them apart.
  - A tall column standing beside a base/wall run is a different cabinet_type and was never part of that run's width; the column-by-column rule below governs it, appliance or not.
- An underpanel, pelmet, or LED strip/track mounted under or alongside a wall cabinet run is a DETAIL of that wall item, not its own item — fold it into that item's "note" (e.g. "19mm underpanel with LED"). Only a light fitting that's clearly unrelated to any cabinet run (a standalone pendant, a strip not on a cabinet underpanel) is its own QTY "other" item.
- An END PANEL (tall end panel, base end panel, any panel called up by name next to a run) is its OWN discrete QTY item (one per panel, calc "QTY", qty 1 each). Unlike an integrated appliance (above), a panel is NOT a continuation of the run's carcase — it's a separate flat component bolted to the end of it, so its width IS carved OUT of whatever base/wall/tall run it sits beside: if a run's printed width includes an end panel at one end, subtract the panel's width before recording that run's qty. Never fold an end panel's width into the adjacent run just because they're drawn touching each other or dimensioned as one span.

== RECOGNIZE THESE BY THEIR LABEL FIRST, NOT BY VISUAL JUDGEMENT ==
Some items are explicitly labelled in text on the drawing. For these, trust the label — don't second-guess it with visual reasoning about shape, position, or symbols. A written word is more reliable than an inferred visual pattern.
- The words "INTEGRATED FRIDGE", "INTEGRATED FREEZER", "INTEGRATED DISHWASHER" (or a close variant like "FRIDGE INTEGRATION") are, by themselves, enough to add that QTY item. The same applies even WITHOUT the word "INTEGRATED" present: a brand/model-coded appliance label sitting inside a cabinet elevation's base or tall band — e.g. "FISHER & PAYKEL DD60STX8I1 DISH DRAWER", "DISH DRAWER", "DISHWASHER" — is being housed by the joinery exactly like a labelled "integrated" one, because it's drawn as part of the cabinetry run rather than as a freestanding appliance. Treat any dishwasher/dish-drawer/fridge/freezer label found WITHIN a cabinet run's elevation this same way, whether or not "INTEGRATED" is printed next to it. You don't need to additionally reason about the gap's geometry to decide whether it qualifies — see it labelled anywhere in the run → add it as its own additional QTY item (qty 1 each), and measure the surrounding LM according to the bench-height vs floor-to-height appliance rule above. Before finishing a room, re-scan every base/tall band on every elevation for a second (or third) appliance label like this one — a fridge being caught correctly is not a reason to assume you've caught all of them; a dishwasher sitting a few hundred mm away in the same run is a separate, equally real QTY item that's easy to miss once you've already found the fridge.
- The word "BIN" labelling a cabinet section (e.g. "400 Pull-Out Bin", "Hafele Bin 2x25L") means: read the width number written on or immediately next to that label (400, 450, etc. — in mm) and name the item using that exact width (e.g. "400mm Pull-Out Bin"), calc "QTY", qty 1 — the width is what matches it to the correct price-book variant, so always carry it in the name even though material_hint also exists.
- The same applies to any other explicitly-labelled fitting — "HAMPER", "CHUTE", "ROD"/"HANGING ROD", "IRONING BOARD", "LED": the label itself is what tells you it exists and what it is; don't require a visually obvious shape or symbol in addition to the label. If a size/width is written with the label, carry it into the item name or note the same way as the bin example.

What a BASE / WALL / TALL cabinet actually looks like, in plain terms (use this alongside the vertical-band test below):
- A BASE cabinet sits directly on the floor, roughly knee-to-bench height (~0-900mm) — it's what a benchtop sits on top of. On an elevation it's the bottom band of the drawing.
- A WALL cabinet is mounted on the wall above bench height, whether or not there's a visible gap below it — on an elevation it's the upper band, often (but not always) with empty space (the benchtop/splashback zone) between it and the base band below.
- A TALL cabinet is ONE single carcase running the full floor-to-ceiling height with no horizontal split at bench height anywhere in it — on an elevation it's a single continuous door/box spanning the entire height of the drawing, not two stacked bands.
If a column on an elevation visibly has a horizontal line splitting it into a lower band and an upper band at roughly bench height, that's a base item AND a wall item, never a single tall item — only an unbroken single column is tall.

== WORKING OUT THE WALLS (read this carefully — this is where most errors happen) ==
A document set for one room usually has MORE sheets than it has walls. Before using any sheet, identify what kind of view it is:
- A FRONT, face-on elevation of a wall, or a plan/floor view — these are the only sources of length/width.
- A side elevation, end elevation, or cross-section detail (narrow, showing one unit in isolation with a depth figure like "650") — this clarifies depth/height/internal layout only. NEVER read a length or qty from one of these, and never treat it as a new wall.
- A 3D/isometric/perspective sketch — a presentation view of walls already measured elsewhere. NEVER a new wall.

Count the room's genuinely distinct FRONT elevations first (each spans its own overall dimension, printed once for the whole sheet — two sheets with two different overall dimensions are two walls). That count is a hard ceiling on how many walls this room has. Give each wall exactly ONE consistent name (e.g. "Front wall", "Return wall") and reuse that same name in every item's "note" that belongs to it — never invent a second name (like "Main wall") for a wall you've already named under a different name.

For EACH wall, work out cabinet_type one vertical band at a time, from the floor up:
1. A cabinet/drawer section sitting on the floor (roughly 0–900mm) → "base".
2. A cabinet mounted above bench height (with or without base cabinetry below) → a separate "wall" item — this applies even with no visible benchtop gap (a door-fronted box sitting directly on a drawer bank is still its own "wall" item).
3. "tall" is ONLY a single cabinet carcase genuinely running floor-to-ceiling with no break at bench height (a pantry, an ironing/broom cupboard, a chute housing). An open void, hanging rod, or doors over a base-height drawer bank is NOT tall — it's base + wall per steps 1–2, even if it visually reaches the ceiling.

A wall is very often more than one COLUMN side by side (e.g. a tall enclosed cupboard next to a column with a base drawer section and a door-fronted wall section above it). Apply the three-step test to EACH COLUMN separately, not once for the whole wall — a tall cupboard on one side doesn't make the rest of the wall tall, and vice versa. A column sitting BETWEEN two tall cupboards (a common layout: ironing cupboard | hanging-rod/drawer column | chute cupboard) still gets its own base and/or wall item — don't fold its hardware into either neighbouring tall cupboard's note.

Within one wall, a run stays ONE item regardless of what's inside it — different drawer brands, a hamper section, a sink's support shelf, a sub-dimensioned split (e.g. 6 drawers + 4 drawers) are all just details for "note", never a reason to split into multiple items. The only things that start a new item are: a genuine change in cabinet_type, a different column, or a different wall. Measuring a run's qty: only when EVERY column along a wall has the same band structure (e.g. the whole wall is a base band with a wall band above it, no tall column, no floor-to-height appliance column) may you use the wall's single OVERALL printed dimension. As soon as a wall mixes column types (base+wall columns, a tall column, a fridge column), do NOT use the overall dimension: instead read the individual column widths from the dimension string printed along the bottom of that elevation, and for EACH cabinet_type add up only the widths of the columns that actually have that band (base lm = columns with a base band, wall lm = columns with a wall band above, tall lm = columns that are one unbroken full-height carcase). Columns with no band of that type contribute nothing to that type. A column can add to two types (a base-and-wall column adds to both; a fridge column adds its full width to tall only). Write the sum you used in the item's note as "columns: a + b + c" using the real printed widths, so it can be checked.

HARD RULE — one item per wall per cabinet_type: before you finalize your answer, check your own output — a single named wall (e.g. "Front wall") must appear as the source of at most ONE "base" item, ONE "wall" item, and ONE "tall" item in your whole answer, never two. If you find yourself about to write a second item whose note would name a wall you've already used for that cabinet_type, that is a sign you are looking at the SAME physical run again from a different sheet (a plan/floor view repeating what an elevation already showed, a second elevation sheet covering the other half of a wall too wide for one sheet, a close-up detail of part of a run already measured) — it is NOT a new item. In that case, go back and fold it into the ONE existing item for that wall and cabinet_type: add its length to that item's qty yourself if it supplies a segment the first sheet didn't cover (e.g. a wall drawn across a "left section" sheet and a "right section" sheet with no overall figure printed anywhere — add the two segment lengths together into ONE item), or ignore it entirely if it's simply the same span shown again (a floor/plan view of a wall you already measured from its elevation, or a cross-section of a run already captured). This self-merging is required WITHIN one wall; it's different from merging ACROSS different walls (front wall total + return wall total), which you do NOT do yourself — report each genuinely different wall's own item separately and the application sums those afterwards. Give a middle/return wall's wall-cabinet item the SAME material_hint as the rest of the room's wall cabinets unless a different finish is explicitly stated for it (a room doesn't switch door finish wall to wall without saying so), and never substitute an underpanel/shelf material for the door finish.

== FIELDS ==
For each item, return:
- "room": the EXACT name printed on the sheet (a heading, or the notes-box title) — never inferred from what fixtures are present (a fridge/dishwasher/sink room is not necessarily a "Kitchen"; it could be a "Pantry", "Scullery", anything printed). "Kitchen"/"Ensuite"/"Laundry" below are just format examples, not a hint. Before listing any items, decide this ONCE: read the title block/notes box and settle on the exact room name (or, only if the sheets genuinely show more than one distinct room, the exact name for each one) as a first step in your reasoning — then reuse that identical string, character for character, on every single item that belongs to it, including fittings and the by-others line. Do not re-decide or re-infer the room per item; a fridge or dishwasher appearing partway through the item list is never a reason to switch to "Kitchen" for just those items when everything else was already given the sheet's real room name. If the whole document is clearly one room, EVERY item gets that one room — don't default to "General" just because an item wasn't individually re-labelled. Only use "General" for a genuinely multi-room document where one specific item's room can't be determined.
- "name": short and specific, never the word "run" (e.g. "Base cabinet", "Laundry chute", "Hanging rod").
- "cabinet_type": "base" | "wall" | "tall" | "other" (anything that isn't a standard cabinet run — benchtop, panel, vanity top, fitting, lighting, hardware).
- "open": true only if the front is drawn with NO door at all. A diagonal line (or a crossing pair) across a cabinet front is a DOOR SWING indicator, meaning that section HAS a door/doors — it is NOT a sign of open shelving. Shelf labels like "ADJ"/"FXD" describe what's on the shelves and say nothing about open vs doored.
- "calc": "LM" (every base/wall/tall run, by width) | "QTY" (discrete items — vanity, end panel, chute, hamper, rod, light, integrated appliance) | "MISC" (anything else).
- "qty": best-estimate number (count for QTY). For LM, this MUST be in METRES as a decimal, never raw millimetres — drawings are dimensioned in mm, so convert by dividing the printed mm figure by 1000 (e.g. a dimension of two thousand four hundred millimetres is qty 2.4, not 2400). Never copy a dimension figure straight into qty without this conversion, and never reuse any number written anywhere in these instructions — every qty must come only from a figure actually printed on the plan you were given, read fresh from that plan.
- "unit": short label matching calc (e.g. "lm", "ea").
- "material_hint": the finish as fully described (material, thickness, profile, range, colour — e.g. "22mm Farmers Doors Weathered Slimline Oak Stained"). For non-cabinet items, whatever distinguishing detail is given. Carry over every descriptive word — this is matched against a price book by exact words. Empty string only if truly nothing is stated.
- "drawer_count": sum of every brand/size-coded drawer-front tag on the run, each counted once (e.g. "2x ANT M" + "4x ANT D" = 6). Count drawer tags on EVERY elevation of the room and in every column of the base run, including a lone drawer tag (e.g. "D 350 DEEP") sitting beneath or beside an appliance such as a dish drawer — write the per-elevation split in the note (e.g. "left 1 + right 6"). A cross-section/detail view of the same bank shown elsewhere is the SAME drawers — don't recount. A section labelled only with a fitting's name (e.g. "HAMPER") and no drawer brand/size code of its own is that fitting's opening, not a drawer — price it as its own QTY item, add nothing to drawer_count for it.
- "pto_drawer_count": how many of drawer_count are push-to-open — only set this when PTO is explicitly noted against the DRAWERS themselves ("PTO" most often labels wall-cabinet DOORS instead, which just gets a note, not this field, and no separate price-book line). Either way — on drawers or on doors — PTO ("Push To Open") must never be silently dropped: count how many PTO labels appear (e.g. two separate "PTO" tags means 2, not 1) and say so explicitly in that item's "note" (e.g. "2x PTO doors"), even when it only affects pto_drawer_count's own item and not a cabinet it's merely adjacent to.
- "drawer_brand": the brand/code exactly as written (e.g. "ANT", "MER") — don't expand or guess. Empty string if none stated.
- "note": for a base/wall/tall item, lead with its wall/location name (matching the one consistent name chosen for that wall) — then any other detail worth keeping (height, hardware, a mixed drawer split). Brief, or empty if nothing beyond the wall reference is needed.
- "confidence": "high" | "medium" | "low".
- "regions": an array of objects — one per PAGE, within the plan document as uploaded (never the finishes/hardware schedule document, and never a written specifications/notes text panel even when it sits right next to the drawing on the same sheet), where this item's actual cabinetry or fitting is GRAPHICALLY DRAWN. Each object is { "page": N, "bbox": [x_min, y_min, x_max, y_max] } where N is the 1-indexed page number in the plan document, and the four bbox numbers are fractions from 0 to 1 of that whole page's width and height — [x_min, y_min] is the top-left corner and [x_max, y_max] the bottom-right corner of a box around the relevant run or fitting.
  - STRONGLY PREFER a front elevation over a floor/plan view as the source for this box. A floor/plan view shows cabinetry from above as one combined footprint with base, wall and tall all overlapping in the same outline — there is no way to draw a box there that isolates just the "base" or just the "wall" portion, so a box on a plan view is almost always too large to be useful. An elevation shows base/wall/tall as clearly separate horizontal bands, so it gives a genuinely tight, specific box. Only use a floor/plan view when no elevation of that wall exists at all.
  - The box must hug the specific run or fitting, not the whole wall, the whole room outline, or the whole sheet — exclude dimension strings, the title block, and any other cabinetry that isn't part of this item.
  - NEVER box the written specifications/notes panel (door/panel/handle schedules, benchtop notes, etc.) even though it describes this exact item — that panel is text ABOUT the item, not a drawing OF it, and boxing it defeats the whole point of this feature (letting someone see the actual cabinetry, not re-read the same words twice).
  - This is for a human to visually sanity-check your read against the drawing, so an honest, reasonably tight box is far more useful than a loose placeholder covering half the page. One run that's drawn on more than one page (e.g. the same wall shown again in a 3D sketch) can have more than one entry. Empty array only if you genuinely cannot localize it on any page.
  - Before writing a bbox down, re-look at the page and check it against these two specific mistakes, because both happen often:
    1. A box that falls in blank margin — empty white space below, above, or beside the drawing, where there is no cabinetry line, door, shelf, or label at all inside the box. If what you're about to report contains no actual drawing content, you have the wrong position; find the band that actually shows this item and box that instead.
    2. A box that swallows more than one band — a wall-cabinet box must stop at the bench-height line and never reach down into the base band below it; a base-cabinet box must stop at that same line and never reach up into the wall band above it. If the box you're about to report is taller than roughly a third of the whole elevation's height, you have almost certainly merged two bands into one box — split it down to just the one band this item actually is.

Also return a top-level "flags" array — short strings for anything to double-check (illegible dimensions, unmatched tags, contradictions, unquantifiable scope).

Also check the title block for "client_name" (the customer, e.g. a "CUSTOMER" field) and "job_address" (street address + suburb/postcode if both given, e.g. "29 Duxford Street, Elizabeth Hills 2171"). Leave either empty if not stated — never guess.

Respond with ONLY a JSON object of this exact shape, no other text:
{
  "client_name": "",
  "job_address": "",
  "items": [ { "room": "...", "name": "...", "cabinet_type": "base", "open": false, "calc": "LM", "qty": 0, "unit": "lm", "material_hint": "", "drawer_count": 0, "pto_drawer_count": 0, "drawer_brand": "", "note": "...", "confidence": "medium", "regions": [ { "page": 1, "bbox": [0.1, 0.2, 0.9, 0.4] } ] } ],
  "flags": [ "..." ]
}`;

type PlanItem = {
  room: string;
  name: string;
  cabinet_type: "base" | "wall" | "tall" | "other";
  open: boolean;
  calc: "LM" | "QTY" | "MISC";
  qty: number;
  unit: string;
  material_hint: string;
  drawer_count: number;
  pto_drawer_count: number;
  drawer_brand: string;
  note: string;
  confidence: "high" | "medium" | "low";
  regions?: { page: number; bbox: [number, number, number, number] }[];
};

/**
 * Reads an uploaded plan (image or PDF page rendered as an image) with
 * Claude's vision and returns a structured list of suggested joinery line
 * items. This replaces the old Claude-Artifact `sample` capability, which
 * only works when the artifact is embedded inside a claude.ai conversation
 * — here the API key is the platform's own, billed to us, so it works for
 * every subscriber regardless of how they open the app.
 */
// Dedicated column-inventory prompt. Run several times in parallel and
// voted on in code (see consensusWalls), because column "kinds" are read off
// the picture and a single read is not repeatable.
const COLUMNS_PROMPT = `You are transcribing the COLUMN LAYOUT of the front elevations of joinery in this drawing. Do not quote or price anything. Find every distinct FRONT elevation of joinery (never a side/end/detail view or a 3D sketch). For each, go column by column from left to right, using the individual figures printed in the dimension string along the bottom of the elevation (the figures between the tick marks), copied EXACTLY — never estimate or compute a width. Include small spacer/filler figures as their own columns with is_gap true.

For each column answer these questions by LOOKING at what is drawn in that column's strip:
  - has_base_cabinets: are cabinet doors/drawers drawn on the floor up to benchtop height (about 0-900mm)? (sink, dishwasher/dish drawer, bin and drawer sections all count)
  - has_wall_cabinets: are cabinet doors, boxes or shelves actually drawn ABOVE the benchtop, hanging, ending below the ceiling? Blank or open wall above the benchtop (splashback, window, rangehood space, sink/mixer notes, a dimension for the splashback) is NO — answer false unless you can point to wall doors there. An elevation bracket or dimension line spanning blank wall does not make it a wall cabinet.
  - is_full_height: is the column ONE unbroken floor-to-ceiling carcase (a pantry, broom cupboard, or an integrated fridge/freezer housing with its doors above)?
  - is_fridge_column: does the column contain an integrated fridge or freezer (label like "INTEGRATED FRIDGE")?
  - is_gap: a spacer, filler, end panel or anything that is not joinery.
  - label: any text printed in the column (copy it, or empty).
A column drawn full height with no benchtop break is full height, not base plus wall.

Return ONLY JSON: { "walls": [ { "name": "Front wall", "page": 1, "overall_mm": 0, "columns": [ { "width_mm": 0, "has_base_cabinets": true, "has_wall_cabinets": false, "is_full_height": false, "is_fridge_column": false, "is_gap": false, "label": "" } ] } ] }
overall_mm is the single overall dimension printed for the whole elevation (0 if none). If a column's width is not printed, set width_mm to 0.`;

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("org_id").eq("id", user.id).single();
  if (!profile) return NextResponse.json({ error: "No organization found." }, { status: 400 });

  const { data: org } = await supabase
    .from("organizations")
    .select("subscription_status")
    .eq("id", profile.org_id)
    .single();
  const active = org?.subscription_status === "active" || org?.subscription_status === "trialing";
  if (!active) {
    return NextResponse.json({ error: "Subscription required to read plans." }, { status: 402 });
  }

  // Files arrive as storage paths, not raw bytes: the browser uploads
  // directly to Supabase Storage first (see handlePlanUpload in
  // QuoteBuilder.tsx), because Vercel's serverless functions reject any
  // request body over ~4.5MB — a real floor plan or finishes schedule PDF
  // routinely exceeds that on its own, let alone both together. This route
  // just fetches the already-uploaded file(s) server-side, where there's no
  // such limit, and deletes them once read.
  const body = await request.json().catch(() => null);
  const planPath: unknown = body?.planPath;
  const schedulePath: unknown = body?.schedulePath;
  // Exact column widths read from the PDF's own text layer by the browser
  // (see lib/dimensionRows.ts). Empty for scans/images.
  type DimStr = { page: number; overall: number; columns: { width: number; x0: number; x1: number; label: string }[] };
  const dimStrings: DimStr[] = Array.isArray(body?.dimensionStrings)
    ? (body.dimensionStrings as DimStr[]).filter(
        (d) =>
          d && typeof d.overall === "number" && Array.isArray(d.columns) && d.columns.length >= 3 && d.columns.length <= 40 &&
          d.columns.every((c) => typeof c.width === "number" && typeof c.x0 === "number" && typeof c.x1 === "number")
      ).slice(0, 12)
    : [];
  if (typeof planPath !== "string" || !planPath) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  const admin = createAdminClient();
  const pathsToClean: string[] = [planPath];
  if (typeof schedulePath === "string" && schedulePath) pathsToClean.push(schedulePath);

  async function toContentBlock(path: string) {
    const { data, error } = await admin.storage.from("plan-uploads").download(path);
    if (error || !data) throw new Error(`Could not retrieve uploaded file: ${error?.message ?? "not found"}`);
    const mediaType = data.type || "application/octet-stream";
    const bytes = Buffer.from(await data.arrayBuffer());
    const base64 = bytes.toString("base64");
    return mediaType === "application/pdf"
      ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } } as const)
      : ({
          type: "image",
          source: { type: "base64", media_type: mediaType as "image/png" | "image/jpeg" | "image/webp", data: base64 },
        } as const);
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let content: unknown[];
  try {
    const planBlock = await toContentBlock(planPath);
    // Worked examples first (see referenceExamples.ts): real Vicello jobs
    // with the correct classification hand-labelled by the business owner,
    // so the model has this company's own drawing conventions to
    // pattern-match against before it ever looks at the actual job below.
    content = [
      {
        type: "text",
        text: "Before the actual job, here are a few worked examples from past Vicello Kitchens jobs. Each one has been hand-annotated (in red/orange) by the business to show the correct classification — the annotations are a teaching aid added afterwards, not something printed on an original drawing. Study how each one reads, then apply the same thinking to the real job that follows.",
      },
      ...REFERENCE_EXAMPLES.flatMap((ex) => [
        { type: "text", text: ex.caption },
        { type: "image", source: { type: "base64", media_type: ex.mediaType, data: ex.data } },
      ]),
      {
        type: "text",
        text: "That's the end of the worked examples. Now here is the ACTUAL job to read and quote from — nothing in it is pre-annotated, so read it fresh using what the examples above just illustrated:",
      },
      { type: "text", text: "Drawing to quote from:" },
      planBlock,
    ];
    if (typeof schedulePath === "string" && schedulePath) {
      const scheduleBlock = await toContentBlock(schedulePath);
      content.push(
        {
          type: "text",
          text: "Finishes & hardware schedule (for resolving codes and nominated hardware only — do not quote line items from this document itself):",
        },
        scheduleBlock
      );
    }
    content.push({ type: "text", text: PLAN_PROMPT });
  } catch (err) {
    console.error("Could not load uploaded file(s) from storage:", err);
    await admin.storage.from("plan-uploads").remove(pathsToClean);
    const detail = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: `Could not read the uploaded file. ${detail}` }, { status: 502 });
  }

  // Clean up the temporary upload(s) now that we've read them into memory —
  // no need to keep them in storage either way, success or failure from here.
  admin.storage.from("plan-uploads").remove(pathsToClean).then(
    () => {},
    () => {}
  );

  type ParsedPlan = {
    client_name?: string;
    job_address?: string;
    items: PlanItem[];
    flags: string[];
    walls?: { room: string; name: string; page: number; overall_mm: number; columns: { width_mm: number; kind: string; label: string }[] }[];
  };

  // A single vision read of a complex multi-page plan isn't deterministic —
  // the same file can come back with a different wall measurement on two
  // separate uploads, because extended thinking (above) runs at temperature
  // 1 by design. Rather than trust one roll of the dice, the plan is read
  // TWICE in parallel and the two independent reads are compared below; any
  // base/wall/tall figure they disagree on is surfaced as an explicit
  // warning instead of silently going with whichever read happened to come
  // back. This doubles the API cost and the thinking latency of a single
  // call, but a wrong, confidently-presented number is worse than that.
  async function readOnce(): Promise<{ parsed: ParsedPlan; error: null } | { parsed: null; error: string }> {
    let message;
    try {
      message = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        // Extended thinking gives the model room to work through the plan
        // step by step — cross-checking one sheet against another, catching
        // its own contradictions — before it commits to the final JSON,
        // instead of having to produce a correct answer to a genuinely hard
        // multi-page reading task in one immediate pass. max_tokens is raised
        // to comfortably cover the thinking budget plus a full item list for
        // a busy multi-room plan; thinking requires temperature 1 (the
        // default here, left unset).
        max_tokens: 12000,
        thinking: { type: "enabled", budget_tokens: 6000 },
        messages: [
          {
            role: "user",
            // The installed SDK version's TypeScript types don't yet include
            // "document" blocks in this content array's union (PDF support
            // was added to the API before the type defs caught up), even
            // though the API itself accepts it — cast at this single call
            // site rather than losing type-safety on the rest of the file.
            content: content as never,
          },
        ],
      } as never);
    } catch (err) {
      console.error("Anthropic plan-read call failed:", err);
      // Surface the actual reason in the response rather than a generic
      // message — digging through Vercel's logs for this is slow, and the
      // Anthropic SDK's error shape varies by failure type, so this reads
      // whatever fields are actually present instead of assuming one.
      const anyErr = err as { status?: number; message?: string; error?: { message?: string } };
      const detail =
        anyErr?.error?.message || anyErr?.message || (err instanceof Error ? err.message : "Unknown error.");
      const status = anyErr?.status;
      return {
        parsed: null,
        error: `Could not read the plan right now.${status ? ` (Anthropic error ${status})` : ""} ${detail}`.trim(),
      };
    }

    const textBlock = message.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { parsed: null, error: "No response from the model." };
    }

    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      return { parsed: JSON.parse(jsonMatch ? jsonMatch[0] : textBlock.text), error: null };
    } catch {
      return { parsed: null, error: "Could not parse the model's response." };
    }
  }

  // Groups a read's base/wall/tall items the same way the client's
  // mergePlanBands does (room + cabinet_type + open/closed), so the two
  // reads are compared band-for-band rather than item-for-item (item order
  // and wall-splitting can differ between reads even when the true total
  // doesn't).
  function summarizeLmBands(items: PlanItem[]): Map<string, { qty: number; label: string }> {
    const out = new Map<string, { qty: number; label: string }>();
    for (const it of items) {
      if (it.calc !== "LM" || !["base", "wall", "tall"].includes(it.cabinet_type)) continue;
      const room = (it.room || "General").trim();
      const key = [room.toLowerCase(), it.cabinet_type, it.open ? "open" : "closed"].join("|");
      const label = `${it.cabinet_type[0].toUpperCase()}${it.cabinet_type.slice(1)} cabinet — ${room}`;
      const existing = out.get(key) || { qty: 0, label };
      existing.qty += it.qty || 0;
      out.set(key, existing);
    }
    return out;
  }

  function compareReads(a: PlanItem[], b: PlanItem[]): string[] {
    const sumsA = summarizeLmBands(a);
    const sumsB = summarizeLmBands(b);
    const keys = new Set([...sumsA.keys(), ...sumsB.keys()]);
    const warnings: string[] = [];
    keys.forEach((key) => {
      const entryA = sumsA.get(key);
      const entryB = sumsB.get(key);
      const qtyA = entryA?.qty ?? 0;
      const qtyB = entryB?.qty ?? 0;
      const label = (entryA || entryB)!.label;
      const diff = Math.abs(qtyA - qtyB);
      const tolerance = Math.max(0.15, 0.15 * Math.max(qtyA, qtyB));
      if (diff > tolerance) {
        if (!entryA || !entryB) {
          warnings.push(
            `${label}: only one of two independent reads found this (${(entryA ? qtyA : qtyB).toFixed(
              3
            )} lm) — the other read missed it entirely. Verify it's really there.`
          );
        } else {
          warnings.push(
            `${label}: two independent reads disagree (${qtyA.toFixed(3)} lm vs ${qtyB.toFixed(
              3
            )} lm) — the AI isn't confident here, double-check against the plan before pricing.`
          );
        }
      }
    });
    return warnings;
  }

  // ---- Column inventory: 3 focused reads, majority-voted in code ----------
  type RawCol = {
    width_mm: number;
    has_base_cabinets?: boolean;
    has_wall_cabinets?: boolean;
    is_full_height?: boolean;
    is_fridge_column?: boolean;
    is_gap?: boolean;
    label?: string;
  };
  type RawWall = { name?: string; page?: number; overall_mm?: number; columns?: RawCol[] };

  async function readColumnsOnce(): Promise<RawWall[] | null> {
    try {
      const colContent: unknown[] = [
        { type: "text", text: "Drawing to read:" },
        content[content.findIndex((b) => (b as { text?: string }).text === "Drawing to quote from:") + 1],
        { type: "text", text: COLUMNS_PROMPT },
      ];
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 7000,
        thinking: { type: "enabled", budget_tokens: 3000 },
        messages: [{ role: "user", content: colContent as never }],
      } as never);
      const tb = msg.content.find((b) => b.type === "text");
      if (!tb || tb.type !== "text") return null;
      const m = tb.text.match(/\{[\s\S]*\}/);
      const j = JSON.parse(m ? m[0] : tb.text);
      return Array.isArray(j.walls) ? (j.walls as RawWall[]) : null;
    } catch (err) {
      console.error("Column inventory read failed:", err);
      return null;
    }
  }

  const COL_FIELDS = ["has_base_cabinets", "has_wall_cabinets", "is_full_height", "is_fridge_column", "is_gap"] as const;

  function consensusWalls(reads: RawWall[][]): {
    walls: { room: string; name: string; page: number; overall_mm: number; columns: { width_mm: number; kind: string; label: string }[] }[];
    warnings: string[];
  } {
    const warnings: string[] = [];
    const out: ReturnType<typeof consensusWalls>["walls"] = [];
    const base = reads[0];
    base.forEach((w0, wi) => {
      const o0 = w0.overall_mm || 0;
      // Match this wall in every read by overall dimension (fallback: index).
      const group: RawWall[] = reads.map((r) => {
        const byOverall = o0 > 0 ? r.find((w) => w.overall_mm && Math.abs((w.overall_mm || 0) - o0) / o0 <= 0.01) : undefined;
        return (byOverall || r[wi]) as RawWall;
      }).filter((w) => w && Array.isArray(w.columns) && w.columns.length > 0);
      if (group.length === 0) return;
      const overall = o0 || group.map((w) => w.overall_mm || 0).find((n) => n > 0) || 0;
      // Pick the width sequence most reads agree on (ties: closest to overall).
      const sigs = new Map<string, { w: RawWall; n: number; sum: number }>();
      for (const w of group) {
        const widths = w.columns!.map((c) => Math.round(c.width_mm || 0));
        const key = widths.join(",");
        const e = sigs.get(key) || { w, n: 0, sum: widths.reduce((a, b) => a + b, 0) };
        e.n++;
        sigs.set(key, e);
      }
      const ranked = Array.from(sigs.values()).sort(
        (a, b) => b.n - a.n || Math.abs(a.sum - overall) - Math.abs(b.sum - overall)
      );
      const best = ranked[0];
      const name = w0.name || `Wall ${wi + 1}`;
      const same = group.filter((w) => w.columns!.map((c) => Math.round(c.width_mm || 0)).join(",") === best.w.columns!.map((c) => Math.round(c.width_mm || 0)).join(","));
      if (best.n < group.length) {
        warnings.push(`${name}: the AI's ${group.length} column reads disagreed on the printed widths — used the version ${best.n} of ${group.length} agreed on; check the Column breakdown.`);
      }
      const columns = best.w.columns!.map((c0, ci) => {
        const vote: Record<string, boolean> = {};
        for (const f of COL_FIELDS) {
          const yes = same.filter((w) => w.columns![ci]?.[f] === true).length;
          vote[f] = yes * 2 > same.length;
          if (yes > 0 && yes < same.length) {
            warnings.push(`${name} column ${Math.round(c0.width_mm || 0)}mm: reads split on "${f.replace(/_/g, " ")}" (${yes} of ${same.length} yes) — majority used; check the Column breakdown.`);
          }
        }
        let kind = "gap";
        if (vote.is_gap) kind = "gap";
        else if (vote.is_full_height || vote.is_fridge_column) kind = "tall";
        else if (vote.has_base_cabinets && vote.has_wall_cabinets) kind = "base_wall";
        else if (vote.has_base_cabinets) kind = "base";
        else if (vote.has_wall_cabinets) kind = "wall";
        return { width_mm: Math.round(c0.width_mm || 0), kind, label: c0.label || "" };
      });
      out.push({ room: "", name, page: w0.page || 1, overall_mm: overall, columns });
    });
    return { walls: out, warnings };
  }


  // ---- Fixed-width mode: widths came from the PDF text, the AI only says
  // what is in each column ------------------------------------------------
  const FIXED_PROMPT = `You are classifying the COLUMNS of the front elevations of joinery in this drawing. The exact column widths have already been read from the drawing's text and are listed below, left to right, for each elevation, with each column's horizontal position as a percentage of the page width. Do NOT change, add or remove columns and do not report widths. For each listed column, look at that column's vertical strip of the elevation (above its position on the page) and answer:
  - has_base_cabinets: cabinet doors/drawers drawn on the floor up to benchtop height (about 0-900mm)? (sink, dishwasher/dish drawer, bin and drawer sections all count)
  - has_wall_cabinets: cabinet doors, boxes or shelves actually DRAWN above the benchtop, hanging, ending below the ceiling? Blank or open wall above the benchtop (splashback, window, rangehood space, sink/mixer notes) is false. An elevation bracket or dimension line over blank wall does not make it a wall cabinet.
  - is_full_height: ONE unbroken floor-to-ceiling carcase (pantry, broom cupboard, or an integrated fridge/freezer housing with its doors above)?
  - is_fridge_column: contains an integrated fridge or freezer?
  - is_gap: a spacer, filler, end panel or anything that is not joinery (very narrow strips are almost always this).
Return ONLY JSON: { "walls": [ { "index": 0, "columns": [ { "index": 0, "has_base_cabinets": true, "has_wall_cabinets": false, "is_full_height": false, "is_fridge_column": false, "is_gap": false } ] } ] } with one entry per listed elevation and one per listed column, in the same order.`;

  function describeDimStrings(): string {
    return dimStrings
      .map(
        (d, i) =>
          `Elevation ${i} (page ${d.page}, overall ${d.overall}mm): ` +
          d.columns
            .map(
              (c, ci) =>
                `[${ci}] ${c.width}mm at ${(c.x0 * 100).toFixed(0)}%-${(c.x1 * 100).toFixed(0)}%${c.label ? ` (text in strip: ${c.label.slice(0, 80)})` : ""}`
            )
            .join("; ")
      )
      .join("\n");
  }

  type FlagCol = Partial<Record<(typeof COL_FIELDS_FIXED)[number], boolean>>;
  const COL_FIELDS_FIXED = ["has_base_cabinets", "has_wall_cabinets", "is_full_height", "is_fridge_column", "is_gap"] as const;

  async function readFixedOnce(): Promise<FlagCol[][] | null> {
    try {
      const planIdx = content.findIndex((b) => (b as { text?: string }).text === "Drawing to quote from:") + 1;
      const msg = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 6000,
        thinking: { type: "enabled", budget_tokens: 2500 },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Drawing to read:" },
              content[planIdx],
              { type: "text", text: `${FIXED_PROMPT}\n\nColumns:\n${describeDimStrings()}` },
            ] as never,
          },
        ],
      } as never);
      const tb = msg.content.find((b: { type: string }) => b.type === "text") as { type: "text"; text: string } | undefined;
      if (!tb) return null;
      const m = tb.text.match(/\{[\s\S]*\}/);
      const j = JSON.parse(m ? m[0] : tb.text);
      if (!Array.isArray(j.walls)) return null;
      return dimStrings.map((d, wi) => {
        const w = j.walls.find((x: { index?: number }) => x.index === wi) || j.walls[wi];
        return d.columns.map((_, ci) => ((w?.columns || []).find((c: { index?: number }) => c.index === ci) || w?.columns?.[ci] || {}) as FlagCol);
      });
    } catch (err) {
      console.error("Fixed-width column classification failed:", err);
      return null;
    }
  }

  function consensusFixed(reads: FlagCol[][][]): {
    walls: { room: string; name: string; page: number; overall_mm: number; columns: { width_mm: number; kind: string; label: string }[] }[];
    warnings: string[];
  } {
    const warnings: string[] = [];
    const walls = dimStrings.map((d, wi) => {
      const name = `Elevation ${wi + 1} (page ${d.page}, ${d.overall}mm)`;
      const columns = d.columns.map((c, ci) => {
        const vote: Record<string, boolean> = {};
        for (const f of COL_FIELDS_FIXED) {
          const yes = reads.filter((r) => r[wi]?.[ci]?.[f] === true).length;
          vote[f] = yes * 2 > reads.length;
          if (yes > 0 && yes < reads.length) {
            warnings.push(`${name}, ${c.width}mm column: reads split on "${f.replace(/_/g, " ")}" (${yes} of ${reads.length} yes) — majority used.`);
          }
        }
        // Deterministic overrides from the drawing's own text and widths.
        if (/fridge|freezer/i.test(c.label)) vote.is_fridge_column = true;
        if (c.width < 60) vote.is_gap = true;
        let kind = "gap";
        if (vote.is_gap) kind = "gap";
        else if (vote.is_full_height || vote.is_fridge_column) kind = "tall";
        else if (vote.has_base_cabinets && vote.has_wall_cabinets) kind = "base_wall";
        else if (vote.has_base_cabinets) kind = "base";
        else if (vote.has_wall_cabinets) kind = "wall";
        return { width_mm: c.width, kind, label: c.label };
      });
      return { room: "", name, page: d.page, overall_mm: d.overall, columns };
    });
    return { walls, warnings };
  }

  const [resultA, resultB, colA, colB, colC, fixA, fixB, fixC] = await Promise.all([
    readOnce(),
    readOnce(),
    dimStrings.length ? Promise.resolve(null) : readColumnsOnce(),
    dimStrings.length ? Promise.resolve(null) : readColumnsOnce(),
    dimStrings.length ? Promise.resolve(null) : readColumnsOnce(),
    dimStrings.length ? readFixedOnce() : Promise.resolve(null),
    dimStrings.length ? readFixedOnce() : Promise.resolve(null),
    dimStrings.length ? readFixedOnce() : Promise.resolve(null),
  ]);
  const fixedReads = [fixA, fixB, fixC].filter((r): r is FlagCol[][] => !!r);

  // If both reads failed outright, there's nothing to fall back to.
  if (!resultA.parsed && !resultB.parsed) {
    return NextResponse.json({ error: resultA.error || resultB.error }, { status: 502 });
  }

  // Prefer whichever read succeeded; if both did, read #1 is used as the
  // one actually shown, with disagreements against read #2 attached as
  // warnings rather than trying to auto-merge or auto-pick a "winner".
  const primary = resultA.parsed || resultB.parsed!;
  const consistencyWarnings =
    resultA.parsed && resultB.parsed ? compareReads(resultA.parsed.items, resultB.parsed.items) : [];

  // Column inventory: vote across the focused reads. Rooms are filled from
  // the main read's items (single-room jobs get that room; multi-room jobs
  // fall back to the wall's name appearing in an item's note).
  const colReads = [colA, colB, colC].filter((r): r is RawWall[] => !!r && r.length > 0);
  let walls: ParsedPlan["walls"] = undefined;
  const colWarnings: string[] = [];
  if (fixedReads.length > 0 || colReads.length > 0) {
    const cons = fixedReads.length > 0 ? consensusFixed(fixedReads) : consensusWalls(colReads);
    const rooms = Array.from(new Set(primary.items.map((i) => (i.room || "General").trim())));
    walls = cons.walls.map((w) => {
      const hit = primary.items.find((i) => (i.note || "").toLowerCase().includes(w.name.toLowerCase()));
      return { ...w, room: (hit?.room || rooms[0] || "General").trim() };
    });
    colWarnings.push(...cons.warnings);
  }

  return NextResponse.json({
    ...primary,
    walls,
    column_source: fixedReads.length > 0 ? "pdf_text" : "ai_picture",
    dim_note: typeof body?.dimNote === "string" ? body.dimNote.slice(0, 200) : "",
    consistency_warnings: [...consistencyWarnings, ...colWarnings],
  });
}
