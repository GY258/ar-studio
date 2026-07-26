import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getTemplate } from "@/lib/templates";
import { viewer } from "@/lib/entitlements";
import { siteUrl, stripe, stripeConfigured } from "@/lib/stripe";
import { grantEntitlement } from "@/lib/db";

export const dynamic = "force-dynamic";

const isProd = process.env.NODE_ENV === "production";

/**
 * 创建 Stripe Checkout Session，返回跳转 URL。
 *
 * 未配置 Stripe 时走体验模式：本地直接发权益，让「点击锁定模板 → 用上」这条链路
 * 在没有任何密钥的情况下也能跑通。生产环境不允许这条路径。
 */
export async function POST(req: Request) {
  const { slug } = (await req.json().catch(() => ({}))) as { slug?: string };
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  const tpl = getTemplate(slug);
  if (!tpl) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (tpl.priceCents === 0) return NextResponse.json({ error: "already_free" }, { status: 400 });

  const v = await viewer();

  if (!stripeConfigured || !stripe) {
    if (isProd) {
      return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });
    }
    // 体验模式：给一个匿名 id 并直接发权益
    let id = v.id;
    if (!id) {
      id = `anon_${crypto.randomUUID()}`;
      cookies().set("ar_anon", id, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    }
    await grantEntitlement(id, slug, "dev");
    return NextResponse.json({ mode: "dev", granted: true, redirectUrl: `/studio/${slug}?unlocked=1` });
  }

  // 真实支付要求先登录：退款回收、跨设备权益都依赖稳定的 user id
  if (!v.authenticated || !v.id) {
    return NextResponse.json({ error: "login_required" }, { status: 401 });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: tpl.priceCents,
          product_data: { name: `AR Studio · ${tpl.name.zh}` },
        },
      },
    ],
    // Webhook 靠这两个字段把订单落到人和模板上
    metadata: { user_id: v.id, slug },
    // 双保险：metadata 同时挂到 PaymentIntent 上，方便在 Stripe 后台按订单排查
    payment_intent_data: { metadata: { user_id: v.id, slug } },
    success_url: `${siteUrl()}/studio/${slug}?unlocked=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl()}/templates?canceled=1`,
  });

  return NextResponse.json({ mode: "stripe", redirectUrl: session.url });
}
