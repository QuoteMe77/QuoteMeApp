import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient, createAdminClient } from "@/lib/supabase/server";

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
- An INTEGRATED APPLIANCE (integrated fridge, dishwasher, etc.) is different from a "by other" appliance: the joinery shop does build its housing, but the appliance's own casing fills that gap, so the gap gets NO base/wall/tall LM item of its own — just one QTY item for the appliance itself (e.g. "Integrated fridge", calc "QTY", qty 1). This matters even when the appliance sits in the middle of an otherwise-continuous run: if you're measuring that run's qty from the wall's single overall printed dimension (as instructed below for a run with no structural break), you MUST subtract the width of EVERY integrated appliance gap within that span before recording qty — a fridge gap AND a dishwasher gap AND any other integrated appliance gap on that same wall, not just the first one you notice. If a run's note says you subtracted one appliance's width, double-check you didn't skip another integrated appliance sitting on that same wall — never let any appliance's own footprint inflate the surrounding base/wall run's length just because it happens to be measured as one overall figure. A sink, bin, or hamper opening stays included (those are real joinery scope); an integrated appliance gap is the one thing in a "whole wall" run that always gets carved back out, every single one of them.
- An underpanel, pelmet, or LED strip/track mounted under or alongside a wall cabinet run is a DETAIL of that wall item, not its own item — fold it into that item's "note" (e.g. "19mm underpanel with LED"). Only a light fitting that's clearly unrelated to any cabinet run (a standalone pendant, a strip not on a cabinet underpanel) is its own QTY "other" item.

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

Within one wall, a run stays ONE item regardless of what's inside it — different drawer brands, a hamper section, a sink's support shelf, a sub-dimensioned split (e.g. 6 drawers + 4 drawers) are all just details for "note", never a reason to split into multiple items. The only things that start a new item are: a genuine change in cabinet_type, a different column, or a different wall. For a run spanning a whole wall with no real structural break, measure its qty from the wall's own single OVERALL printed dimension rather than re-adding segments by hand — that total already includes every section (sink, hamper, appliance housing) along it.

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
- "drawer_count": sum of every brand/size-coded drawer-front tag on the run, each counted once (e.g. "2x ANT M" + "4x ANT D" = 6). A cross-section/detail view of the same bank shown elsewhere is the SAME drawers — don't recount. A section labelled only with a fitting's name (e.g. "HAMPER") and no drawer brand/size code of its own is that fitting's opening, not a drawer — price it as its own QTY item, add nothing to drawer_count for it.
- "pto_drawer_count": how many of drawer_count are push-to-open — only set this when PTO is explicitly noted against the DRAWERS themselves ("PTO" most often labels wall-cabinet DOORS instead, which just gets a note, not this field, and no separate price-book line).
- "drawer_brand": the brand/code exactly as written (e.g. "ANT", "MER") — don't expand or guess. Empty string if none stated.
- "note": for a base/wall/tall item, lead with its wall/location name (matching the one consistent name chosen for that wall) — then any other detail worth keeping (height, hardware, a mixed drawer split). Brief, or empty if nothing beyond the wall reference is needed.
- "confidence": "high" | "medium" | "low".

Also return a top-level "flags" array — short strings for anything to double-check (illegible dimensions, unmatched tags, contradictions, unquantifiable scope).

Also check the title block for "client_name" (the customer, e.g. a "CUSTOMER" field) and "job_address" (street address + suburb/postcode if both given, e.g. "29 Duxford Street, Elizabeth Hills 2171"). Leave either empty if not stated — never guess.

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

  type ParsedPlan = { client_name?: string; job_address?: string; items: PlanItem[]; flags: string[] };

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

  const [resultA, resultB] = await Promise.all([readOnce(), readOnce()]);

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

  return NextResponse.json({ ...primary, consistency_warnings: consistencyWarnings });
}
