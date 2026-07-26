import "server-only";
import { cookies } from "next/headers";
import { currentUser } from "./auth";
import { unlockedSlugs } from "./db";
import { isFree } from "./templates";

/**
 * 权益判断的唯一入口。前端的锁态只是 UI 提示，真正说了算的是这里（PRD 8）。
 *
 * 未登录用户有一个匿名 id（cookie），用来在开发 / 体验模式下持有解锁记录。
 * 生产环境下匿名 id 不参与付费权益——付费必须先登录，否则换个浏览器就没了，
 * 而且没法做退款回收。
 */

const ANON_COOKIE = "ar_anon";

export function anonId(): string | null {
  return cookies().get(ANON_COOKIE)?.value ?? null;
}

export interface Viewer {
  /** 登录用户 id，或 dev 模式下的匿名 id。 */
  id: string | null;
  authenticated: boolean;
}

export async function viewer(): Promise<Viewer> {
  const user = await currentUser();
  if (user) return { id: user.id, authenticated: true };
  const anon = anonId();
  return { id: anon, authenticated: false };
}

export async function unlockedFor(v: Viewer): Promise<Set<string>> {
  if (!v.id) return new Set();
  return new Set(await unlockedSlugs(v.id));
}

/** 免费模板永远过；付费模板必须在权益表里查到。 */
export async function canUse(slug: string, v: Viewer): Promise<boolean> {
  if (isFree(slug)) return true;
  if (!v.id) return false;
  return (await unlockedFor(v)).has(slug);
}
