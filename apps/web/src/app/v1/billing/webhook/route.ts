import { proxyStripeBillingWebhook } from "@/lib/stripe-webhook-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return proxyStripeBillingWebhook(req);
}

export async function GET(req: Request) {
  return proxyStripeBillingWebhook(req);
}
