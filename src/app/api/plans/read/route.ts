import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const PLAN_PROMPT = `You are an experienced joinery estimator reviewing construction drawings (a floor plan, elevation, or joinery/cabinetry detail sheet) for a kitchen, bathroom, laundry or similar fit-out. You may also be given a second document — a finishes & hardware schedule — listing the materials, finishes and hardware (drawer systems, handles, pull-outs) nominated for this job, sometimes under coded references (e.g. "L1", "PC1") that the drawing calls up against a cabinet run. If given, resolve any such codes against the schedule and use it to fill in material and drawer-brand details for the items you find on the drawing; the schedule is a source of truth for finishes, not something to quote line items from directly.

Identify every distinct piece of joinery/cabinetry scope shown or called up on the drawing: base cabinets, wall cabinets, tall/pantry cabinets, end panels, bulkheads, shelving, vanities, wardrobes, and similar built-in joinery. Use dimensions, run lengths, item tags/callouts (e.g. "B1", "W3", "PC1"), and room labels wherever they are legible.

For each distinct item, return:
- "room": the room or area name it belongs to (e.g. "Kitchen", "Ensuite", "Laundry"). Use "General" if unclear.
- "name": a short, specific description (e.g. "Base cabinet run", "Tall pantry cabinet", "Wall cabinet with shelf")
- "cabinet_type": one of "base", "wall", "tall", or "other" — "other" for anything that isn't a standard base/wall/tall cabinet run (a benchtop, panel, vanity top, shelf, etc.)
- "open": true if this run is called up as open/shelving (no doors), false otherwise
- "calc": one of "LM" (priced per linear metre — use for cabinet runs, benchtops, panelling), "QTY" (priced per unit — use for discrete items like a single vanity or shelf), or "MISC" (anything that doesn't fit either)
- "qty": your best-estimate quantity as a plain number (linear metres for LM, count for QTY)
- "unit": a short unit label matching the calc type (e.g. "lm", "ea")
- "material_hint": the specific finish/material named for this item on the drawing or the finishes schedule (e.g. "Polytec Matt", "19mm American Oak Veneer"), or an empty string if none is stated — never guess one
- "drawer_count": the number of drawers in this run as a plain number, 0 if none
- "drawer_brand": the drawer system/brand explicitly nominated for this item on the drawing or finishes schedule (e.g. "Merivo", "Legrabox", "Movento"), or an empty string if none is stated — never guess one
- "note": any other relevant detail worth carrying onto a quote line (height, specific hardware called up, a tag reference) — keep it brief, or an empty string if nothing extra is needed
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
    return NextResponse.json({ error: "Could not read the uploaded file. Please try again." }, { status: 502 });
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
    return NextResponse.json({ error: "Could not read the plan right now. Please try again." }, { status: 502 });
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
