import {
  createStoredPreviewFromBody,
  json,
  privateAccountOwnerFromRequest,
  readJson,
  rejectForbiddenFields,
  unauthorized,
} from "../../_lib";
import { validateTradeOrderPlan, type TradeOrderPlan } from "@/lib/trade-order-plan";
import {
  issueTradeOrderPlanBinding,
  tradeOrderPlanBindingSecret,
} from "@/lib/trade-order-plan-binding.server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readJson(req);
  const forbidden = rejectForbiddenFields(body);
  if (forbidden) return forbidden;
  const owner = await privateAccountOwnerFromRequest(req);
  if (!owner) return unauthorized();
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  let orderPlan: TradeOrderPlan | null = null;
  let bindingSecret: string | null = null;
  if (value.order_plan !== undefined) {
    const validation = validateTradeOrderPlan(value.order_plan, { requireFresh: true });
    if (!validation.ok) return json({ error: validation.error }, 400);
    bindingSecret = tradeOrderPlanBindingSecret();
    if (!bindingSecret) return json({ error: "order_plan_binding_unavailable" }, 503);
    orderPlan = validation.plan;
  }
  const preview = await createStoredPreviewFromBody(body, owner);
  if ("error" in preview) return json({ error: preview.error }, 400);
  if (!orderPlan || !bindingSecret) return json(preview);
  try {
    const binding = issueTradeOrderPlanBinding({
      orderPlan,
      previewCommitment: preview.preview.preview_commitment,
      subjectCommitment: owner.owner_commitment,
      previewExpiresAt: preview.preview.expires_at,
      secret: bindingSecret,
    });
    return json({ ...preview, trade_order_plan_binding: binding });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "order_plan_binding_failed" }, 400);
  }
}
