const HEALTHY_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export function subscriptionNeedsAttention(status: string | null | undefined): boolean {
  return Boolean(status) && !HEALTHY_SUBSCRIPTION_STATUSES.has(status!);
}
