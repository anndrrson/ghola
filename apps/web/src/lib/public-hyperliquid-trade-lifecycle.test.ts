import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentSource = readFileSync(
  resolve(process.cwd(), "src/components/trade/PublicCoinbaseLiveTrade.tsx"),
  "utf8",
);
const verifierSource = readFileSync(
  resolve(process.cwd(), "scripts/verify-prod-hyperliquid.mjs"),
  "utf8",
);
const privateAccountServerSource = readFileSync(
  resolve(process.cwd(), "src/app/v1/private-account/_lib.ts"),
  "utf8",
);

describe("public Hyperliquid lifecycle integration", () => {
  it("removes the submit control before execution and reconciles every acknowledgement", () => {
    const orderContract = componentSource.slice(
      componentSource.indexOf("const manualPerpOrder"),
      componentSource.indexOf("const perpOrder"),
    );
    const removeReview = componentSource.indexOf("setPerpReview(null);", componentSource.indexOf("async function submitPerpOrder"));
    const execute = componentSource.indexOf("await executePrivateAccountAction", removeReview);
    const reconcile = componentSource.indexOf("await reconcilePerpOrder(reviewed.previewCommitment, reviewed.order);", execute);

    expect(removeReview).toBeGreaterThan(0);
    expect(execute).toBeGreaterThan(removeReview);
    expect(reconcile).toBeGreaterThan(execute);
    expect(componentSource).toContain("This exact order remains locked");
    expect(componentSource).toContain("Check this exact order on Hyperliquid");
    expect(componentSource).toContain('status: "ambiguous", result');
    expect(componentSource).not.toContain('setPerpAttempt({ previewCommitment, order, status: "failed", result });');
    expect(privateAccountServerSource).toContain(
      'submitted.error === "connector_submit_failed"',
    );
    expect(orderContract).toContain('order_type: "market"');
    expect(orderContract).not.toContain('live_order_mode: "tiny_fill"');
    expect(orderContract).toContain('tif: "Ioc"');
    expect(orderContract).not.toContain("tif: orderType");
  });

  it("reconciles through the selected attested worker instead of a stale static endpoint", () => {
    const reconcileRoute = privateAccountServerSource.slice(
      privateAccountServerSource.indexOf("export async function connectorReconcileFromBody"),
      privateAccountServerSource.indexOf("export async function connectorOperationsForOwner"),
    );

    expect(reconcileRoute).toContain("await connectorRuntimeEnv(workOrderRecord.platform_class)");
    expect(reconcileRoute).toContain("env: connectorEnv");
  });

  it("prepares closes only from exact reconciled fill proof", () => {
    expect(componentSource).toContain("provenHyperliquidFill(perpAttempt.result)");
    expect(componentSource).toContain("buildHyperliquidReduceOnlyClose(perpAttempt.order, fill)");
    expect(componentSource).toContain("Prepare exact reduce-only close");
    expect(componentSource).toContain("Hyperliquid reports zero positions and zero open orders");
  });

  it("uses one focused onboarding action before exposing the order ticket", () => {
    expect(componentSource).toContain("Start trading in minutes");
    expect(componentSource).toContain('router.push(product === "perps" && venue === "hyperliquid" ? setupHref : signinHref);');
    expect(componentSource).toContain('? "Start trading"');
    expect(componentSource).toContain('hyperliquidAction.action !== "review"');
    expect(componentSource).toContain("Withdrawals remain disabled · no trade during setup");
  });

  it("serializes initial worker access and bounds every pre-trade worker request", () => {
    const accountSnapshotRoute = privateAccountServerSource.slice(
      privateAccountServerSource.indexOf("export async function hyperliquidAccountSnapshotForOwner"),
      privateAccountServerSource.indexOf("export async function hyperliquidAccountStreamForOwner"),
    );
    const sessionRoute = privateAccountServerSource.slice(
      privateAccountServerSource.indexOf("async function requestHyperliquidAgentSession"),
      privateAccountServerSource.indexOf("async function requestHyperliquidManagedAllocation"),
    );
    const accountMount = componentSource.slice(
      componentSource.indexOf("let stream: ReturnType<typeof openHyperliquidAccountStream>"),
      componentSource.indexOf("function changePerpMarket"),
    );

    expect(accountSnapshotRoute).toContain("fetchWithTimeout");
    expect(sessionRoute).toContain("fetchWithTimeout");
    expect(privateAccountServerSource).toContain('positiveIntegerEnv("GHOLA_POOLED_WORKER_WAKE_WAIT_MS", 12_000)');
    expect(privateAccountServerSource).toContain("15_000");
    expect(accountMount.indexOf("const response = await fetch")).toBeLessThan(accountMount.indexOf("connectStream();"));
    expect(accountMount).not.toContain("void armHyperliquidExecutionAgent");
    expect(componentSource).toContain("tradingReady: hyperliquidReadiness.ready");
  });

  it("makes the release verifier reconcile without resubmitting", () => {
    expect(verifierSource).toContain('postJson("/v1/private-account/connectors/reconcile"');
    expect(verifierSource).toContain("the verifier will not resubmit it");
    expect(verifierSource).toContain('protective_orders: { stop_loss: stopLoss }');
    expect(verifierSource).not.toContain('live_order_mode: "tiny_fill"');
    expect(verifierSource).toContain('order_type: "market"');
    expect(verifierSource).toContain("quote_size: quoteSize");
    expect(verifierSource).toContain("GHOLA_VERIFY_HYPERLIQUID_STOP_LOSS must be a positive price");
    expect(verifierSource.match(/postJson\("\/v1\/private-account\/actions\/execute"/g)).toHaveLength(1);
  });
});
