import "server-only";
import Stripe from "stripe";

/**
 * Stripe Checkout 托管收银台，不自建支付表单（避免 PCI 合规负担）。
 * 一次性买断，非订阅。
 *
 * 没配 STRIPE_SECRET_KEY 时 stripe 为 null，/api/checkout 会走「体验模式」：
 * 直接发权益并返回回跳地址，让本地开发能跑通整条链路。
 * 生产环境缺 key 会在 db.ts 之外再挡一道，见 /api/checkout。
 */

const key = process.env.STRIPE_SECRET_KEY;

export const stripe = key ? new Stripe(key, { apiVersion: "2024-06-20" }) : null;
export const stripeConfigured = stripe !== null;
export const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}
