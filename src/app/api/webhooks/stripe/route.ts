import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe, webhookSecret } from "@/lib/stripe";
import {
  claimStripeEvent,
  findOrderByPaymentIntent,
  grantEntitlement,
  markOrderStatus,
  recordOrder,
  revokeEntitlement,
} from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // 验签需要原始 body，不能用 edge

/**
 * 发放权益的唯一可信来源。
 *
 * 两条硬要求（PRD 8）：
 *  - 必须验签。不验签的话任何人都能 POST 一个 checkout.session.completed 白嫖。
 *  - 必须幂等。Stripe 会重发同一个事件，claimStripeEvent 保证只处理一次。
 *
 * 退款和争议走 charge.refunded / charge.dispute.created 自动回收。
 */
export async function POST(req: Request) {
  if (!stripe || !webhookSecret) {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "missing_signature" }, { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (e) {
    return NextResponse.json({ error: `invalid_signature: ${(e as Error).message}` }, { status: 400 });
  }

  if (!(await claimStripeEvent(event.id))) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.metadata?.user_id;
      const slug = s.metadata?.slug;
      if (userId && slug && s.payment_status === "paid") {
        const pi = typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null);
        // 先落订单再发权益：退款回收要靠 orders 反查买的是哪个模板
        await recordOrder({
          userId,
          slug,
          sessionId: s.id,
          paymentIntent: pi,
          amountCents: s.amount_total ?? 0,
          currency: s.currency ?? "usd",
        });
        await grantEntitlement(userId, slug, "stripe", s.id);
      }
      break;
    }
    case "charge.refunded":
    case "charge.dispute.created": {
      const c = event.data.object as Stripe.Charge;
      const pi = typeof c.payment_intent === "string" ? c.payment_intent : (c.payment_intent?.id ?? null);
      if (!pi) break;
      // 不读 charge.metadata —— Stripe 不保证把 Checkout Session 的 metadata
      // 传到 charge 上，读了会静默什么也不做。自己的 orders 表才靠得住。
      const order = await findOrderByPaymentIntent(pi);
      if (order) {
        await revokeEntitlement(order.userId, order.slug);
        await markOrderStatus(pi, event.type === "charge.refunded" ? "refunded" : "disputed");
      }
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
