import type {
  PrivateExecutionOperationClass,
  PrivateExecutionVenueId,
} from "./private-execution-instruction-seal";
import type { TradeOrderVenueId } from "./trade-order-plan";

export interface TerminalLiveOrderMode {
  orderType: "limit";
  timeInForce: "gtc" | "ioc";
  operationClass: PrivateExecutionOperationClass;
  workerVenueId: PrivateExecutionVenueId;
  includeBaseSize: boolean;
  liveAvailable: boolean;
  label: string;
  explanation: string;
}

/** Exact one-shot mode the terminal can bind and the hardened worker can recover safely. */
export function terminalLiveOrderMode(venue: TradeOrderVenueId): TerminalLiveOrderMode {
  if (venue === "coinbase") {
    return {
      orderType: "limit",
      timeInForce: "ioc",
      operationClass: "spot_limit_order",
      workerVenueId: "coinbase_advanced",
      includeBaseSize: false,
      liveAvailable: false,
      label: "Live unavailable",
      explanation: "Coinbase submit is locked until cancellation and reservation recovery pass production-grade proofs.",
    };
  }
  if (venue === "phoenix") {
    return {
      orderType: "limit",
      timeInForce: "gtc",
      operationClass: "limit_order",
      workerVenueId: "phoenix",
      includeBaseSize: true,
      liveAvailable: false,
      label: "Live unavailable",
      explanation: "Phoenix submit is locked until exact submit and cancellation recovery pass production-grade proofs.",
    };
  }
  return {
    orderType: "limit",
    timeInForce: "ioc",
    operationClass: "limit_order",
    workerVenueId: "hyperliquid",
    includeBaseSize: true,
    liveAvailable: true,
    label: "Limit · IOC",
    explanation: "Bound signed IOC limit: fills within the exact price cap, then cancels any remainder; no unmanaged resting order.",
  };
}
