import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { unlockedFor, viewer } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/** 用户信息 + 已解锁 slug 列表。 */
export async function GET() {
  const v = await viewer();
  const user = await currentUser();
  const unlocked = [...(await unlockedFor(v))];
  return NextResponse.json({ user, unlocked, authenticated: v.authenticated });
}

/** 删除账号（GDPR）。真实实现要连带删除 orders / entitlements / usage_events。 */
export async function DELETE() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // TODO(M2): 软删 users.deleted_at + 级联清理，并给用户发确认邮件
  return NextResponse.json({ error: "not_implemented" }, { status: 501 });
}
