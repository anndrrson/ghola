import { afterEach, describe, expect, it, vi } from "vitest";
import { emitOperationalAlert } from "./operations-alert";

describe("operational alerts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits a sanitized structured log without requiring a webhook", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await emitOperationalAlert({
      code: "connector_submit_ambiguous secret=value",
      route: "/v1/private-account/connectors/submit",
      severity: "critical",
      correlation_id: "ghola-correlation-123",
      duration_ms: 123.4,
    }, {});

    expect(result).toEqual({ delivered: false, reason: "alert_webhook_unconfigured" });
    const payload = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(payload.level).toBe("error");
    expect(payload.code).toBe("connector_submit_ambiguous_secret_value");
    expect(JSON.stringify(payload)).not.toContain("secret=value");
  });

  it("delivers only to an HTTPS webhook", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await emitOperationalAlert({
      code: "reconcile_failed",
      route: "/v1/private-account/connectors/reconcile",
      severity: "warning",
    }, {
      GHOLA_OPERATIONS_ALERT_WEBHOOK: "https://alerts.example.test/ghola",
    }, fetcher as typeof fetch);

    expect(result).toEqual({ delivered: true, status: 202 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
