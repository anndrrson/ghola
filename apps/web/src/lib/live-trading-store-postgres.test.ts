import { describe, expect, it, vi } from "vitest";
import {
  getLiveTradingLaunchControl,
  resetLiveTradingStoreForTests,
  setLiveTradingSqlClientForTests,
} from "./live-trading-store";

describe("live-trading Postgres schema bootstrap", () => {
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
      expect(transactionTag).toHaveBeenCalledTimes(8);
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
});
