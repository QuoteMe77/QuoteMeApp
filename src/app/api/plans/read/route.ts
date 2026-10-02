import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const PLAN_PROMPT = `You are an experienced joinery estimator reviewing a construction document set (floor plans, elevations, joinery/cabinetry detail sheets, and — often within the same document — a finishes, fixtures & equipment (FFE) schedule or joinery finishes/hardware page) for a kitchen, bathroom, laundry or similar fit-out. Read every page provided, including any finishes/materials/hardware schedule page, whether it's part of the main drawing set or supplied as a second document. That schedule is the source of truth for materials and hardware — use it to resolve coded references (e.g. "L1", "PC1") the drawing calls up against a cabinet run, and to fill in the exact finish and drawer brand for every item, even when nothing is explicitly tagged on the drawing itself (match by room/run description if there's no code). The schedule itself is not something to quote line items from directly — it informs the items found on the actual drawings.

Identify every distinct piece of joinery scope shown or called up on the drawing — not just cabinet runs. This includes:
- base cabinets, wall cabinets, tall/pantry cabinets, end panels, bulkheads, shelving, vanities, wardrobes, and similar built-in cabinetry
- discrete fittings and accessories called up on the drawing or schedule that a joinery shop supplies and installs: laundry chutes, laundry hampers, hanging rods, ironing boards/boards-in-cabinet, sink installation, LED strip lighting, shadowline reveals called up as their own item (not just the one baked into a cabinet run's pricing), and anything comparable — these are just as much part of the scope as a cabinet run, so don't skip them because they aren't a run of cabinetry.

Do NOT create a separate item for handles (e.g. "Handles - Base cabinet doors", "Handles - Base drawers") — handle hardware is already included in a cabinet run's own LM rate, never a separately billed line, so leave it out of the items list entirely even when the schedule specifies a handle style/code.

Anything the schedule marks as supplied or installed by someone other than the joinery shop — stone benchtops, splashbacks, tap/mixer supply or installation, appliances ("by other", "client supplied", "existing"), and similar — is not joinery scope to price at all. Don't list these individually (no separate "Splashback" item, no separate "Mixer installation" item, etc.) and don't try to quantify or dimension them. Instead, add ONE single combined item for the whole job noting what's excluded, e.g. name "Stone benchtop / Splashback / Appliances — by others", calc "MISC", qty 1, unit "item" — a single line so the quote records the exclusion without pricing or itemizing it.

Report each wall's own run as its OWN separate item — even when another wall in the same room has a run of the same cabinet type and finish. Do NOT try to combine, sum, or merge anything across walls yourself: that arithmetic is done afterwards by the application, automatically and deterministically, from the atomic per-wall items you report here. Your only job for each wall is to get that one wall's own qty, drawer_count, and pto_drawer_count right, on their own — never add another wall's figure into them, and never leave a wall's own item out just because you expect it to be "the same as" or "covered by" another wall's item.

This split is by WALL ONLY — never by what sits inside the run. A single wall's base (or wall, or tall) cabinetry stays ONE item covering that wall's full run, even when the run is visibly made up of different functional sections along its length — e.g. a stretch of plain drawers, then a narrower section below a hamper or ironing-board opening, then a section with a fixed shelf supporting a sink — and even when those sections nominate different drawer brands/codes (e.g. some drawers tagged "ANT D" and others "ANT M" within the same run). Do NOT create "Base cabinet with drawers", "Base cabinet with hamper drawer", and "Base cabinet with sink" as three separate items for one wall — that is still one wall, so it is ONE base-cabinet item: measure its full combined length along that one wall, add up every drawer in it regardless of which section or brand code each drawer sits under into one drawer_count, and use "note" to call out the mix (e.g. "Front wall — includes hamper drawer section (2x ANT M) and fixed shelf below sink"). The ONLY thing that creates a new item is a genuine change in cabinet_type (base vs wall vs tall) or a move to a different wall — a different fitting or drawer brand partway along the same wall's same-type run is just a detail to note, never a reason to split it into another item. If a run is shown split across more than one elevation sheet of the SAME wall (e.g. a wide run drawn in two overlapping sections of one elevation, or a drawer bank dimensioned 6+4 in two adjacent details of the one run), that is also still a single wall and a single item. It's only separate walls (a front wall and a return wall, two legs of an L-shaped run, etc.) that must now be reported as separate items, one per wall, and left unsummed.

Use the "note" field to say which wall/location each item belongs to (e.g. "Front wall", "Return wall", "Left end wall") — this is how the application tells matching items apart and merges them back together correctly, so always fill it in with a specific wall/location reference, not just a generic description.

Read a run's length/width from the dimension line that runs ALONG the same direction as the run itself (the elevation's own overall width dimension, or the plan view's run length) — never from a depth, height, or cross-section figure taken from a side-view or detail drawing of the same unit, which measures a different axis entirely and will give the wrong number. This mistake is easiest to make on a wall elevation that also has internal vertical dimensions running down its side (floor-to-bench height, drawer heights, a section height) right next to the column you're measuring — a number like that sits close to the column and can look like it belongs to it, but it's a HEIGHT, not that column's width, and using it will under- or over-state the run by exactly the kind of amount a height/width mix-up produces. Whenever a wall or room also has its own plan/floor view, that view's horizontal figures are the authoritative width for every column on that wall — actively cross-check each column's width against the plan view's own dimension string for that wall (which should list each column's width end to end, e.g. "637 | 1189 | 685") rather than taking a number straight off the elevation, and if an elevation number and the plan view's number for what should be the same column disagree, use the plan view's.

A tall cupboard that houses a fitting (a chute, a hamper, an ironing-board recess) is still a tall CABINET in its own right and needs its own LM contribution to the tall-cabinet total, in addition to — not instead of — any separate QTY item for the fitting it houses (e.g. "Laundry chute" priced as its own unit). Don't skip the housing's cabinetry width just because the fitting inside it is already counted elsewhere.

An INTEGRATED APPLIANCE (an integrated fridge, dishwasher, or similar) is different: the appliance's own casing fills its entire gap, so that gap does NOT get its own base/wall/tall LM item at all — only a single QTY item for the appliance (e.g. "Integrated fridge", calc "QTY", qty 1), noting the model/size called up. Don't report an "Integrated fridge housing" or similar as a tall/base/wall cabinet with its own LM width — that gap isn't cabinetry the joinery shop builds out, unlike a chute or hamper housing above.

The same applies at base height: a cabinet section that exists specifically to support or surround a fitting — a fixed shelf under a sink, a section sized around a hamper opening, a section beside or housing a client-supplied/"by other" appliance — is still ordinary base cabinetry with its own width, and that width MUST be included in the base run's total qty, never left out because it "supports a fitting" or "houses an appliance" rather than holding plain drawers/doors. This holds even when that section's own contents (the appliance itself, the sink, the hamper insert) are excluded from pricing elsewhere as "by other" — the surrounding cabinetry/housing is still joinery scope and still counts toward the base run's length. The simplest way to get this right: when a base or wall run is made up of several such sections side by side along ONE wall with no actual structural break between them (no gap in the carcase/benchtop/overhead run — a change of contents inside one section, like a sink or an appliance, is not a structural break), measure that run's qty from the wall's own OVERALL dimension for that run (the single total figure usually printed above or below the full elevation, e.g. "4205") rather than by adding up each section's individual sub-dimension one at a time — the overall figure already is the correct sum and is far less error-prone than re-adding several numbers by hand. Only switch to measuring individual segments when the wall genuinely has more than one base/wall/tall band side by side (per the column guidance below) and you need just one column's own width, not the whole wall's.

A room is very often drawn across more than one elevation sheet — one per wall — plus a plan/floor view showing how those walls join. Check every elevation AND the plan view for the same room before finalizing quantities: a return wall around a corner, shown on its own elevation sheet, is its own item (per the paragraph above about reporting each wall separately) even if its cabinet type and finish match the front wall's — don't quantify only the most prominent elevation and treat a return/perpendicular wall's cabinetry as already covered or out of scope just because it will end up merged with the front wall's total later. Use the plan view's dimensions to cross-check that every segment on every wall has been picked up and reported as its own item.

Before treating any sheet as "another wall," check what kind of view it actually is — a document set for one room very often includes MORE sheets than it has walls, and not every extra sheet is a new location to quantify:
- A side-view/cross-section detail of a single cabinet or opening (narrow, usually showing a depth figure like "650" or "460" and one unit in isolation — a bin, a dishwasher recess, a shelf layout) is a DETAIL of a run you've already measured from its main elevation, not a new wall. Never create a new base/wall/tall item from one of these, and never add its depth/width figure to an existing item's qty — it's there to clarify height/depth/internal layout, not to add length.
- A 3D/isometric/perspective sketch of the room (drawn at an angle, showing the cabinetry "in the room" rather than flat-on) is a presentation view of walls you've already measured flat-on elsewhere in the document — never a new wall, and never a reason to add anything to a total.
Only a flat, front-on elevation of a wall (or a plan/floor view) is a source of NEW base/wall/tall quantity. If you can't tell which wall a sheet's flat elevation belongs to, match it against the plan view's layout before assuming it's an extra wall nobody's measured yet — a genuinely two-wall room has exactly two elevations to quantify from, however many total sheets the document contains.

Never read a length/qty figure off a SIDE elevation, end elevation, or cross-section (a narrow view showing a cabinet's depth, like "650" or "460", rather than its length along the wall) — only a wall's own FRONT, face-on elevation (or the plan/floor view) ever gives you that wall's length. A side/end/cross-section view exists purely to show depth or internal layout and must never be used to calculate an LM qty for any item, under any circumstances.

Before you name any wall/location in a "note", first count how many genuinely distinct, full, front-on elevations this room actually has — each one spans the wall's own full dimension string start to end (e.g. a sheet whose overall width reads "3593" is one wall; a different sheet whose overall width reads "2238" is a second, different wall). That count is a hard ceiling: if the room has two such elevations, there are exactly two walls to report items for, full stop — never invent a third wall label (like calling part of one elevation "Front wall" and another part of the SAME elevation "Main wall", as if they were different walls). Give each of the room's actual walls exactly ONE consistent name and use that same name every time you reference it across every item's "note" — if you're ever tempted to write a new wall name, first check it isn't just another name for a wall you've already named.

Use dimensions, run lengths, item tags/callouts (e.g. "B1", "W3", "PC1"), and room labels wherever they are legible.

For each distinct item, return:
- "room": the room or area name it belongs to, taken from the literal text printed on the drawing itself — a large heading at the top of a sheet, or the room name given at the top of the notes/specification box — not guessed or inferred from what kind of fixtures or appliances happen to be in it. A room full of kitchen-style appliances (a fridge, a dishwasher, a sink) is not necessarily a "Kitchen" — it's exactly as likely to be a "Pantry", a "Butler's Pantry", a "Scullery", or anything else the sheet actually calls it, and kitchens are not the only room type this prompt will ever see. Read the room's actual printed name and use that verbatim; "Kitchen", "Ensuite", and "Laundry" below are only examples of the FORMAT a room name takes, never a hint that one of those three is more likely than whatever name is actually printed in front of you. When the whole document set is clearly for one named room (most jobs are — the title block, sheet titles, or the room labelled on the plan all point to the same room), give EVERY item that same room name, including discrete fittings, accessories, and the combined by-others exclusion item — don't default one of those to "General" just because it wasn't individually re-labelled next to its own callout; it's still part of the one room the rest of the drawing is for. Only use "General" when the document genuinely covers more than one room and a specific item's room truly can't be determined, or the whole job has no room named anywhere.
- "name": a short, specific description — never use the word "run" (e.g. "Base cabinet", "Tall pantry cabinet", "Wall cabinet with shelf", "Laundry chute", "Hanging rod")
- "cabinet_type": one of "base", "wall", "tall", or "other" — "other" for anything that isn't a standard base/wall/tall cabinet run (a benchtop, panel, vanity top, shelf, laundry fitting, lighting, hardware call-out, etc.).

  Work out cabinet_type BEFORE deciding whether runs combine — classify every wall's elevation one vertical band at a time, from the floor up, rather than looking at a wall as a whole and picking one type for everything on it:
  1. Is there a cabinet/drawer section sitting on the floor, roughly 0–900mm high? → that band is a "base" item, however tall the wall or the void above it continues.
  2. Is there a cabinet mounted on the wall above bench height (with or without a base cabinet below it)? → that band is a separate "wall" item. This still applies even when there's no visible benchtop/splashback gap between it and the base cabinet below (e.g. a door-fronted section sitting directly on top of a drawer bank, with no bench break) — a distinct door front/cabinet box above a base section is a "wall" item purely because it's a separate box, whether or not a gap or benchtop separates it from what's below. Don't skip this step just because the wall in question has no obvious bench-height gap like a kitchen or the room's main wall does.
  3. Only call something "tall" when ONE cabinet carcase genuinely runs floor-to-ceiling as a single enclosed unit with no break at bench height (a pantry, a broom/ironing-board cupboard, a chute housing). An open void, hanging rod, or set of doors over a base-height drawer bank is NOT "tall" — it's base (the drawer section) plus wall (the door-fronted section above it) per steps 1–2, even if it visually reaches the ceiling.
  A single wall very often produces TWO OR THREE items this way (e.g. a base band, a wall band above it, and a genuinely tall cupboard beside both) — this is normal and expected, not a sign something was miscounted. Every wall in the room gets this same three-step treatment individually — don't apply it to the most prominent wall and then treat a secondary or return wall as already covered by that one wall's items: report that wall's own base/wall/tall bands as their own items too, per the note above about not combining across walls.

  A wall elevation is very often made up of more than one COLUMN side by side across its width — e.g. a genuinely tall, fully-enclosed cupboard on one side (housing a chute or an ironing board), and right next to it a completely different column that has an open or drawer section at the bottom with something else above it. Apply the three-step base/wall/tall test SEPARATELY to each column, not once for the wall as a whole: a tall cupboard occupying part of a wall's width does NOT make the rest of that same wall "tall" too, and an open/drawer column elsewhere on the wall does NOT mean a genuinely enclosed cupboard column beside it should be downgraded out of "tall". Figure out how many columns the elevation has first (usually visible as vertical division lines, or a clear change in what's drawn at a given height), then run the base/wall/tall test on each column independently, producing cabinet_type items per column, not per wall. A column that has a base-height drawer section with an open void, hanging rod, and/or doors above it still produces its own "base" item AND its own "wall" item for that same column — report both, even when a neighbouring column on the same wall is a single tall enclosed cupboard with neither a base nor a wall item of its own.

  This exact situation — a middle column with a hanging rod/LED void and doors above a drawer bank, sitting BETWEEN two genuinely tall enclosed cupboards on the same wall (e.g. an ironing-board cupboard on one side, a chute cupboard on the other) — is a common layout and a common place to go wrong: the middle column's door-fronted section above its drawers is its OWN separate "wall" item, not a detail of either neighbouring tall cupboard. Don't fold the hanging rod, LED, door count, or PTO mentions for that middle column into a tall cupboard's "note" just because they're drawn close together or on the same elevation — give the middle column's wall-height section its own item with its own cabinet_type "wall", its own qty (that column's width), and its own note, exactly as if it were the only thing on that wall. A tall cupboard's own note should only describe what's inside that cupboard itself (the fitting it houses), never a neighbouring column's hardware.

  Give that middle column's "wall" item the SAME door finish (material_hint) as every other wall-cabinet item in the same room, unless the drawing or schedule explicitly calls out a different finish for that specific column — a room's wall cabinets are door finish X throughout unless stated otherwise, they don't switch finish partway along one wall just because a different wall happens to also carry the hanging rod and LED. Don't write the finish of an internal underpanel, shelf, or panel lining as if it were the cabinet door finish — material_hint for a "wall" (or "base"/"tall") item always describes the door/front finish of that cabinet box, which for most columns in one room is the one finish already established for the room, not whatever secondary material is mentioned nearby.

  An underpanel, pelmet, LED strip/track, or similar fitting called up UNDER or ALONGSIDE a wall cabinet run (e.g. "19mm Farmers underpanel with LED", "Hafele LED 2101 track and diffuser") is a detail OF that wall cabinet item, never a standalone item of its own — it has no separate length or price-book line. Fold it into the relevant wall item's "note" (e.g. "19mm underpanel with LED") and do not also create a second item for it with its own qty/cabinet_type — the only exception is a light fitting that is clearly its own discrete accessory unrelated to any cabinet run (e.g. a standalone pendant or a strip light not mounted to a cabinet underpanel), which stays a normal QTY "other" item as usual.
- "open": true if this run is called up as open/shelving (no doors), false otherwise. On these elevations, a diagonal line or a pair of crossing diagonal lines drawn across a cabinet front is a DOOR SWING indicator — it means that section HAS a door (one diagonal = one door, a crossing pair = two doors or a wider door) and is therefore closed (open: false), never a sign of open shelving. A shelf-type label like "ADJ" (adjustable) or "FXD" (fixed) describes what's on the shelves inside, which says nothing about whether the front is open or has a door — plenty of doored sections are labelled "ADJ" too, for the adjustable shelving sitting behind the door. Only mark a section "open" when its front is drawn with no door-swing line at all.
- "calc": one of "LM" (priced per linear metre — use for EVERY base/wall/tall cabinet run, including a single tall cupboard measured by its width, benchtops, and panelling), "QTY" (priced per unit — use for discrete items like a single vanity, end panel, chute, hamper, rod, or light fitting, never for a base/wall/tall cabinet run), or "MISC" (anything that doesn't fit either)
- "qty": your best-estimate quantity as a plain number (linear metres for LM, count for QTY)
- "unit": a short unit label matching the calc type (e.g. "lm", "ea")
- "material_hint": the finish resolved from the drawing or finishes schedule, written out as fully as it's described there — door/panel material, thickness, profile (e.g. "Shaker", "Farmers", "Flat panel"), manufacturer/range, and colour, in whatever combination is actually stated (e.g. "22mm Farmers Doors Weathered Slimline Oak Stained", "18mm Polytec Boston Oak Range", "Polytec Woodmatt"). For a non-cabinet item this is whatever distinguishing detail is given (size, colour, model) rather than a cabinet finish. Carry over every descriptive word the schedule or drawing gives you — this gets matched against a price book by those exact words, so a vague hint ("timber") matches far worse than the full description ("19mm American Oak Veneer G1S Clear Polyurethane"). Leave it an empty string only if truly nothing is stated anywhere — never invent one.
- "drawer_count": the TOTAL number of drawers in this run — standard-opening plus push-to-open combined — as a plain number, 0 if none. Count each physical drawer front exactly once: a cross-section or side-view detail of the same drawer bank shown elsewhere on the sheet (to dimension drawer heights, for example) is the SAME drawers, not additional ones — don't add it again because it appears in a second view. Count drawer fronts directly from the elevation that shows the whole run, not from a detail view. Work this out by counting every brand/size-coded drawer front tag on the run exactly once each (e.g. "2x ANT M" + "4x ANT D" = 6) — that sum IS the final drawer_count for that run, nothing more and nothing less. A section of the same run labelled only with a fitting's name (e.g. "HAMPER", a bin pull-out) and NOT also tagged with its own drawer brand/size code is that fitting's own opening, not a drawer — don't add it to drawer_count at all, it's priced as its own separate QTY item instead (a laundry hamper, a bin, etc.), same as any other discrete fitting. Only add to drawer_count when a section carries an actual drawer brand/size code of its own; never add an extra count on top of the brand-tag sum just because a hamper or similar fitting is also mentioned somewhere in the same run.
- "pto_drawer_count": how many of those drawers (out of drawer_count) are push-to-open (no handle, opened by pressing the drawer front) rather than standard-opening — a plain number, 0 if none/all standard. A run can be entirely push-to-open (pto_drawer_count equal to drawer_count), entirely standard (0), or a mix of both. "PTO" most commonly labels overhead/wall cabinet DOORS, not drawers — only set this field when PTO is explicitly noted against the drawers themselves. A PTO door is not drawer hardware and doesn't get its own price-book line (doors are already part of the cabinet's own rate, the same as handles) — just mention it in that wall/tall item's "note" instead (e.g. "2 of 8 doors push-to-open").
- "drawer_brand": the drawer system/brand nominated for this item, exactly as written on the drawing or schedule — including if it's a short code or abbreviation rather than a full name (e.g. "ANT", "MER", "LEG", "MOV") — leave it as that literal code/text rather than expanding or guessing what it stands for. Empty string if none is stated.
- "note": for a base/wall/tall cabinet item, lead with which wall/location it's from (e.g. "Front wall", "Return wall") per the instruction above — then any other relevant detail worth carrying onto a quote line (height, specific hardware called up, a tag reference, a mixed drawer-style split). Keep it brief, or an empty string if nothing extra is needed beyond the wall reference.
- "confidence": "high", "medium", or "low" — how confident you are in this item and its quantity from what's actually legible on the drawing

Also include a top-level "flags" array of short strings for anything an estimator should double-check by eye before quoting — illegible dimensions, tags with no matching legend, contradictions between drawings, or scope you could not confidently quantify at all.

Also look at the drawing's title block (usually bottom-left or bottom-right of the sheet) for who the job is for and where it is: "client_name" is the customer/client name shown there (e.g. a "CUSTOMER" field), and "job_address" is the site address, combining a street address with its suburb/postcode if both are given (e.g. "29 Duxford Street, Elizabeth Hills 2171"). Leave either as an empty string if the title block doesn't state it — never guess or invent one from a room label or anything else on the drawing.

Respond with ONLY a JSON object of this exact shape, no other text:
{
  "client_name": "",
  "job_address": "",
  "items": [ { "room": "...", "name": "...", "cabinet_type": "base", "open": false, "calc": "LM", "qty": 0, "unit": "lm", "material_hint": "", "drawer_count": 0, "pto_drawer_count": 0, "drawer_brand": "", "note": "...", "confidence": "medium" } ],
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
};

/**
 * Reads an uploaded plan (image or PDF page rendered as an image) with
 * Claude's vision and returns a structured list of suggested joinery line
 * items. This replaces the old Claude-Artifact `sample` capability, which
 * only works when the artifact is embedded inside a claude.ai conversation
 * — here the API key is the platform's own, billed to us, so it works for
 * every subscriber regardless of how they open the app.
 */
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
    content = [{ type: "text", text: "Drawing to quote from:" }, planBlock];
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

  let message;
  try {
    message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          // The installed SDK version's TypeScript types don't yet include
          // "document" blocks in this content array's union (PDF support was
          // added to the API before the type defs caught up), even though
          // the API itself accepts it — cast at this single call site rather
          // than losing type-safety on the rest of the file.
          content: content as never,
        },
      ],
    });
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
    return NextResponse.json(
      {
        error: `Could not read the plan right now.${status ? ` (Anthropic error ${status})` : ""} ${detail}`.trim(),
      },
      { status: 502 }
    );
  }

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return NextResponse.json({ error: "No response from the model." }, { status: 502 });
  }

  let parsed: { client_name?: string; job_address?: string; items: PlanItem[]; flags: string[] };
  try {
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : textBlock.text);
  } catch {
    return NextResponse.json({ error: "Could not parse the model's response." }, { status: 502 });
  }

  return NextResponse.json(parsed);
}
