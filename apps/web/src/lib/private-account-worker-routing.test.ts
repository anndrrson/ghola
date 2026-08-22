import { describe, expect, it } from "vitest";
import { resolveHyperliquidWorkerUrl } from "./private-account-worker-routing";

describe("resolveHyperliquidWorkerUrl", () => {
  it("prefers the selected attested provider over stale static endpoints", () => {
    expect(resolveHyperliquidWorkerUrl({
      selected_provider_execution_url: "https://worker.prod9.example",
      connector_url: "https://worker.prod5.example",
      execution_url: "https://worker.prod5.example",
      worker_url: "https://worker.prod9.example",
    })).toBe("https://worker.prod9.example");
  });

  it("preserves the static endpoint fallback order without a selected provider", () => {
    expect(resolveHyperliquidWorkerUrl({
      connector_url: "https://connector.example",
      execution_url: "https://execution.example",
      worker_url: "https://worker.example",
      phala_endpoint: "https://phala.example",
    })).toBe("https://connector.example");
  });
});
