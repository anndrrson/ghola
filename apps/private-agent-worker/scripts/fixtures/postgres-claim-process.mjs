import { createPostgresWorkerState } from "../../src/state/private-state.js";

const [, , databaseUrl, workOrderCommitment, requestDigest] = process.argv;
if (!databaseUrl || !workOrderCommitment || !requestDigest) process.exit(2);

const state = createPostgresWorkerState(databaseUrl, { driver: "pg" });
try {
  const result = await state.claimExecution(workOrderCommitment, {
    venue_id: "hyperliquid",
    platform_class: "hyperliquid_style_market",
    execution_mode: "testnet",
    operation_class: "perp_limit_order",
    request_digest: requestDigest,
  });
  process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
} finally {
  await state.close();
}
