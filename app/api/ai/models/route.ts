import { NextRequest, NextResponse } from "next/server";
import { resolveAccess, listModels } from "@/lib/llm";
import { aiErrorResponse } from "@/lib/aiRoute";

// Hits OrcaRouter → Node runtime, never static.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/ai/models → { models: string[] }
// Lists the model ids the caller's OWN key can access, to populate the ⚙ Settings
// model picker. Only a pasted own key (mode="user") can pick a model, so only it
// gets a list; the shared key and the owner's bypass are locked to the free model
// (→ []). The key is used server-side only (via resolveAccess), never returned.
export async function GET(req: NextRequest) {
  const access = resolveAccess(req.headers.get("x-orca-key"));
  if (!access || access.mode !== "user") {
    return NextResponse.json({ models: [] });
  }
  try {
    const models = await listModels(access.keys[0]);
    return NextResponse.json({ models });
  } catch (err) {
    return aiErrorResponse(err, { models: [] });
  }
}
