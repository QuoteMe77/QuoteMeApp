import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const PLAN_PROMPT = `You are an experienced joinery estimator reviewing a construction document set (floor plans, elevations, joinery/cabinetry detail sheets, and — often within the same document — a finishes, fixtures & equipment (FFE) schedule or joinery finishes/hardware page) for a kitchen, bathroom, laundry or similar fit-out. Read every page provided, including any finishes/materials/hardware schedule page, whether it's part of the main drawing set or supplied as a second document. That schedule is the source of truth for materials and hardware — use it to resolve coded references (e.g. "L1", "PC1") the drawing calls up against a cabinet run, and to fill in the exact finish and drawer brand for every item, even when nothing is explicitly tagged on the drawing itself (match by room/run description if there's no code). The schedule itself is not something to quote line items from directly — it informs the items found on the actual drawings.

Identify every distinct piece of joinery scope shown or called up on the drawing — not just cabinet runs. This includes:
- base cabinets, wall cabinets, tall/pantry cabinets, end panels, bulkheads, shelving, vanities, wardrobes, and similar built-in cabinetry
- discrete fittings and accessories called up on the drawing or schedule that a joinery shop supplies and installs: laundry chutes, laundry hampers, hanging rods, ironing boards/boards-in-cabinet, sink or tap/mixer installation, LED strip lighting, shadowline reveals called up as their own item (not just the one baked into a cabinet run's pricing), and anything comparable — these are just as much part of the scope as a cabinet run, so don't skip them because they aren't a run of cabinetry.
- scope the joinery shop coordinates, cuts for, or installs but doesn't supply or price itself — splashbacks, stone benchtops, and tap/mixer installation are the common examples. Still list each of these as its own item (so nothing is missing from the quote), named plainly (e.g. "Splashback", "Stone benchtop", "Mixer installation") — don't try to price or quantify these beyond a sensible qty/unit, the app marks them as no-charge/POA automatically from the name.

A single continuous run of cabinetry is one item, even if the drawing shows it spanning more than one wall, return leg, or elevation view (e.g. the two legs of an L-shaped or U-shaped kitchen, or a run shown split across two elevation sheets) — as long as the cabinet type, finish, and drawer/hardware configuration are the same, report ONE item with the combined total length/qty and the combined total drawer_count, not a separate item per wall or per sheet. Only split a run into separate items when something about it actually differs between the segments (a different finish, a different cabinet type, or a different drawer brand/count). The same applies to a single drawer bank that happens to be shown or dimensioned in parts (e.g. 6 drawers on one part of a run and 4 on another, same run) — report it as one drawer_count total (10), not two separate items.

Use dimensions, run lengths, item tags/callouts (e.g. "B1", "W3", "PC1"), and room labels wherever they are legible.

For each distinct item, return:
- "room": the room or area name it belongs to (e.g. "Kitchen", "Ensuite", "Laundry"). Use "General" if unclear.
- "name": a short, specific description (e.g. "Base cabinet run", "Tall pantry cabinet", "Wall cabinet with shelf", "Laundry chute", "Hanging rod")
- "cabinet_type": one of "base", "wall", "tall", or "other" — "other" for anything that isn't a standard base/wall/tall cabinet run (a benchtop, panel, vanity top, shelf, laundry fitting, lighting, hardware call-out, etc.)
- "open": true if this run is called up as open/shelving (no doors), false otherwise
- "calc": one of "LM" (priced per linear metre — use for cabinet runs, benchtops, panelling), "QTY" (priced per unit — use for discrete items like a single vanity, end panel, chute, hamper, rod, or light fitting), or "MISC" (anything that doesn't fit either)
- "qty": your best-estimate quantity as a plain number (linear metres for LM, count for QTY)
- "unit": a short unit label matching the calc type (e.g. "lm", "ea")
- "material_hint": the finish resolved from the drawing or finishes schedule, written out as fully as it's described there — door/panel material, thickness, profile (e.g. "Shaker", "Farmers", "Flat panel"), manufacturer/range, and colour, in whatever combination is actually stated (e.g. "22mm Farmers Doors Weathered Slimline Oak Stained", "18mm Polytec Boston Oak Range", "Polytec Woodmatt"). For a non-cabinet item this is whatever distinguishing detail is given (size, colour, model) rather than a cabinet finish. Carry over every descriptive word the schedule or drawing gives you — this gets matched against a price book by those exact words, so a vague hint ("timber") matches far worse than the full description ("19mm American Oak Veneer G1S Clear Polyurethane"). Leave it an empty string only if truly nothing is stated anywhere — never invent one.
- "drawer_count": the number of drawers in this run as a plain number, 0 if none. If the run has a mixed configuration (e.g. 8 standard-opening drawers and 2 push-to-open drawers), put the total count here and spell out the split in "note" instead — the drawer_count/drawer_brand fields can only describe one uniform style per item.
- "drawer_brand": the drawer system/brand nominated for this item, exactly as written on the drawing or schedule — including if it's a short code or abbreviation rather than a full name (e.g. "ANT", "MER", "LEG", "MOV"), and including a push-to-open notation if one applies to the whole run (e.g. "ANT PTO") — leave it as that literal code/text rather than expanding or guessing what it stands for. Empty string if none is stated.
- "note": any other relevant detail worth carrying onto a quote line (height, specific hardware called up, a tag reference, which wall/run this is, a mixed drawer-style split) — keep it brief, or an empty string if nothing extra is needed
- "confidence": "high", "medium", or "low" — how confident you are in this item and its quantity from what's actually legible on the drawing

Also include a top-level "flags" array of short strings for anything an estimator should double-check by eye before quoting — illegible dimensions, tags with no matching legend, contradictions between drawings, or scope you could not confidently quantify at all.

Respond with ONLY a JSON object of this exact shape, no other text:
{
  "items": [ { "room": "...", "name": "...", "cabinet_type": "base", "open": false, "calc": "LM", "qty": 0, "unit": "lm", "material_hint": "", "drawer_count": 0, "drawer_brand": "", "note": "...", "confidence": "medium" } ],
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

  let parsed: { items: PlanItem[]; flags: string[] };
  try {
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : textBlock.text);
  } catch {
    return NextResponse.json({ error: "Could not parse the model's response." }, { status: 502 });
  }

  return NextResponse.json(parsed);
}
