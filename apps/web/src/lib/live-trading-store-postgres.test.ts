import { describe, expect, it, vi } from "vitest";
import {
  getLiveTradingLaunchControl,
  resetLiveTradingStoreForTests,
  setLiveTradingSqlClientForTests,
  transitionLiveTradingLaunchControl,
} from "./live-trading-store";

describe("live-trading Postgres schema bootstrap", () => {
  it("fails closed when Postgres is required without a database URL", async () => {
    const previous = {
      store: process.env.GHOLA_PRIVATE_ACCOUNT_STORE,
      gholaUrl: process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL,
      databaseUrl: process.env.DATABASE_URL,
      postgresUrl: process.env.POSTGRES_URL,
      nodeEnv: process.env.NODE_ENV,
    };
    try {
      process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "postgres";
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.GHOLA_PRIVATE_ACCOUNT_DATABASE_URL;
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
      resetLiveTradingStoreForTests();
      await expect(getLiveTradingLaunchControl()).rejects.toThrow("live_trading_postgres_url_required");
    } finally {
      restore("GHOLA_PRIVATE_ACCOUNT_STORE", previous.store);
      restore("GHOLA_PRIVATE_ACCOUNT_DATABASE_URL", previous.gholaUrl);
      restore("DATABASE_URL", previous.databaseUrl);
      restore("POSTGRES_URL", previous.postgresUrl);
      restore("NODE_ENV", previous.nodeEnv);
      resetLiveTradingStoreForTests();
    }
  });

  it("single-flights concurrent callers through one advisory-locked transaction", async () => {
    const previousStore = process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let releaseMigration: (() => void) | undefined;
    const migrationGate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const query = vi.fn(async () => []);
    const transactionTag = vi.fn(() => ({ queryData: {} }));
    const transaction = vi.fn(async (builder: (sql: typeof transactionTag) => unknown[]) => {
      const statements = builder(transactionTag);
      await migrationGate;
      return statements.map(() => []);
    });
    Object.assign(query, { transaction });

    try {
      process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "postgres";
      process.env.DATABASE_URL = "postgres://schema-test.invalid/ghola";
      setLiveTradingSqlClientForTests(query as never);

      const requests = Array.from({ length: 20 }, () => getLiveTradingLaunchControl());
      await vi.waitFor(() => expect(transaction).toHaveBeenCalledTimes(1));
      releaseMigration?.();
      const controls = await Promise.all(requests);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transactionTag).toHaveBeenCalledTimes(12);
      expect(controls).toHaveLength(20);
      expect(controls.every((control) => control.state === "disabled")).toBe(true);
    } finally {
      if (previousStore === undefined) delete process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
      else process.env.GHOLA_PRIVATE_ACCOUNT_STORE = previousStore;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      resetLiveTradingStoreForTests();
    }
  });

  it("uses atomic Postgres CAS predicates while leaving kill unconditional", async () => {
    const previousStore = process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const statements: string[] = [];
    const stored = launchControl();
    const { revision: omittedRevision, ...setControl } = stored;
    void omittedRevision;
    const query = vi.fn(async (strings: TemplateStringsArray) => {
      statements.push(Array.from(strings).join("?").replace(/\s+/gu, " "));
      return [{ control: stored, revision: stored.revision }];
    });
    const transactionTag = vi.fn(() => ({ queryData: {} }));
    const transaction = vi.fn(async (builder: (sql: typeof transactionTag) => unknown[]) =>
      builder(transactionTag).map(() => []));
    Object.assign(query, { transaction });

    try {
      process.env.GHOLA_PRIVATE_ACCOUNT_STORE = "postgres";
      process.env.DATABASE_URL = "postgres://launch-cas-test.invalid/ghola";
      setLiveTradingSqlClientForTests(query as never);
      await transitionLiveTradingLaunchControl({
        kind: "kill",
        updated_by: "operator:kill",
        updated_at: stored.updated_at,
        evidence_commitment: "kill_evidence",
      });
      await transitionLiveTradingLaunchControl({
        kind: "set",
        expected_revision: 1,
        control: { ...setControl, state: "public" },
      });
      await transitionLiveTradingLaunchControl({
        kind: "reset",
        expected_revision: 1,
        updated_by: "operator:reset",
        updated_at: stored.updated_at,
        evidence_commitment: "reset_evidence",
      });

      expect(statements[0]).toContain("ON CONFLICT (control_id) DO UPDATE SET state = 'killed'");
      expect(statements[0]).toContain("revision = live_trading_launch_control.revision + 1");
      expect(statements[1]).toContain("live_trading_launch_control.state <> 'killed'");
      expect(statements[1]).toContain("live_trading_launch_control.revision = ?");
      expect(statements[2]).toContain("AND state = 'killed' AND revision = ?");
    } finally {
      if (previousStore === undefined) delete process.env.GHOLA_PRIVATE_ACCOUNT_STORE;
      else process.env.GHOLA_PRIVATE_ACCOUNT_STORE = previousStore;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      resetLiveTradingStoreForTests();
    }
  });
});

function launchControl() {
  const now = new Date("2026-08-19T00:00:00.000Z").toISOString();
  return {
    version: 2 as const,
    revision: 1,
    state: "killed" as const,
    contract_version: 2 as const,
    web_git_sha: null,
    worker_git_sha: null,
    worker_image_digest: null,
    config_fingerprint: null,
    public_capabilities: ["limit_order" as const],
    caps: {
      first_proof_notional_usd: 11,
      max_order_notional_usd: 100,
      rolling_24h_notional_usd: 500,
      default_slippage_bps: 50,
      max_slippage_bps: 100,
    },
    evidence_commitment: "test_evidence",
    updated_by: "operator:test",
    created_at: now,
    updated_at: now,
  };
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
