import { NextResponse } from "next/server";
import { allTemplates, toListing } from "@/lib/templates";
import { unlockedFor, viewer } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/**
 * 列表。付费模板只返回预览信息和价格，不返回 config（PRD 5.5）。
 *
 * hidden 的不进列表 —— 调试模板和没做完的模板不该出现在模板库里。
 * 注意这只是列表过滤，不是权限：/api/templates/<slug>/config 照常下发。
 */
export async function GET() {
  const v = await viewer();
  const unlocked = await unlockedFor(v);
  const items = allTemplates()
    .filter((t) => !t.hidden)
    .map((t) => toListing(t, unlocked.has(t.slug)));
  return NextResponse.json({ items, authenticated: v.authenticated });
}
