import { NextResponse } from "next/server";
import { getTemplate } from "@/lib/templates";
import { canUse, viewer } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/**
 * 返回完整配置。免费模板直接过，付费模板必须先在服务端确认权益。
 *
 * 这是整个产品最容易被白嫖的一个点：物理参数一旦全量打进前端 bundle，
 * 抄走配置就等于拿到了模板。所以配置只能从这里出，而且不能缓存到 CDN。
 */
export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const tpl = getTemplate(params.slug);
  if (!tpl) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const v = await viewer();
  if (!(await canUse(tpl.slug, v))) {
    return NextResponse.json(
      { error: "locked", slug: tpl.slug, priceCents: tpl.priceCents },
      { status: 403 },
    );
  }

  return NextResponse.json(
    { config: { ...tpl, locked: false } },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
