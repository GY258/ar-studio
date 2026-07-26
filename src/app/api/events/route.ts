import { NextResponse } from "next/server";
import { recordEvents } from "@/lib/db";
import { viewer } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "view",
  "camera_grant",
  "camera_deny",
  "record_start",
  "record_download",
  "unlock_click",
]);

/** 埋点批量上报。漏斗就是靠这几个事件算出来的（PRD 1.4 成功指标）。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { events?: unknown } | null;
  const list = Array.isArray(body?.events) ? body!.events : [];
  if (list.length === 0 || list.length > 50) {
    return NextResponse.json({ error: "bad_batch" }, { status: 400 });
  }

  const v = await viewer();
  const rows = list
    .map((e) => e as { event?: string; slug?: string; meta?: unknown })
    .filter((e) => typeof e.event === "string" && ALLOWED.has(e.event))
    .map((e) => ({ userId: v.id, slug: e.slug ?? null, event: e.event!, meta: e.meta }));

  await recordEvents(rows);
  return NextResponse.json({ ok: true, accepted: rows.length });
}
