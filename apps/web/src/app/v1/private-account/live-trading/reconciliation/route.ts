import {
  createLiveTradingReconciliationPost,
  liveTradingReconciliationDependencies,
} from "./_handler";

export const dynamic = "force-dynamic";

export const POST = createLiveTradingReconciliationPost(
  liveTradingReconciliationDependencies,
);
