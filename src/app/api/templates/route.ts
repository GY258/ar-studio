import { NextResponse } from "next/server";
import { allTemplates, toListing } from "@/lib/templates";
import { unlockedFor, viewer } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/** 列表。付费模板只返回预览信息和价格，不返回 config（PRD 5.5）。 */
export async function GET() {
  const v = await viewer();
  const unlocked = await unlockedFor(v);
  const items = allTemplates().map((t) => toListing(t, unlocked.has(t.slug)));
  return NextResponse.json({ items, authenticated: v.authenticated });
}
