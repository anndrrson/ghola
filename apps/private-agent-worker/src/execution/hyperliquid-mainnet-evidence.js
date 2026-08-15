import { createHash } from "node:crypto";

const DECIMAL_SCALE = 12;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

/**
 * Re-queries Hyperliquid's public info API after both orders have filled.
 * Nothing here trusts the submission response or Ghola's durable receipt.
 */
export async function verifyHyperliquidMainnetVenueEvidence({
  baseUrl,
  accountAddress,
  market,
  entry,
  exit,
  protection = null,
  expectedNotionalUsd,
  fetchImpl = fetch,
  attempts = 20,
  retryDelayMs = 250,
}) {
  const endpoint = validMainnetBaseUrl(baseUrl);
  const account = String(accountAddress || "").trim().toLowerCase();
  const coin = String(market || "").trim().toUpperCase();
  const notionalCap = Number(expectedNotionalUsd);
  if (!/^0x[0-9a-f]{40}$/u.test(account)) throw evidenceError("Hyperliquid proof account is invalid");
  if (!/^[A-Z0-9]{2,12}$/u.test(coin)) throw evidenceError("Hyperliquid proof market is invalid");
  if (!Number.isFinite(notionalCap) || notionalCap < 10) throw evidenceError("Hyperliquid proof notional is invalid");
  const entryRef = validateExpectedReference(entry, "entry");
  const exitRef = validateExpectedReference(exit, "exit");
  const protectionRef = protection ? validateProtectionReference(protection) : null;
  if (entryRef.oid === exitRef.oid || entryRef.cloid === exitRef.cloid) {
    throw evidenceError("Hyperliquid proof order references are not distinct");
  }
  if (decimalUnits(entryRef.filledBaseSize) !== decimalUnits(exitRef.filledBaseSize)) {
    throw evidenceError("Hyperliquid proof entry and exit sizes differ");
  }
  if (protectionRef && new Set([
    entryRef.cloid,
    exitRef.cloid,
    protectionRef.takeProfit.cloid,
    protectionRef.stopLoss.cloid,
  ]).size !== 4) {
    throw evidenceError("Hyperliquid proof order identities are not distinct");
  }

  let lastError = null;
  const boundedAttempts = Number.isInteger(attempts) && attempts > 0 ? Math.min(attempts, 40) : 20;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      return await collectVenueEvidence({
        endpoint,
        account,
        coin,
        entryRef,
        exitRef,
        protectionRef,
        notionalCap,
        fetchImpl,
      });
    } catch (error) {
      lastError = error;
      if (attempt < boundedAttempts) await delay(retryDelayMs);
    }
  }
  throw evidenceError(`independent Hyperliquid proof failed${
    lastError instanceof Error ? `: ${lastError.message}` : ""
  }`);
}

async function collectVenueEvidence({
  endpoint,
  account,
  coin,
  entryRef,
  exitRef,
  protectionRef,
  notionalCap,
  fetchImpl,
}) {
  const protectionQueries = protectionRef ? [
    postInfo(fetchImpl, endpoint, { type: "orderStatus", user: account, oid: protectionRef.takeProfit.cloid }),
    postInfo(fetchImpl, endpoint, { type: "orderStatus", user: account, oid: protectionRef.stopLoss.cloid }),
  ] : [];
  const [entryStatus, exitStatus, userFills, state, openOrders, ...protectionStatuses] = await Promise.all([
    postInfo(fetchImpl, endpoint, { type: "orderStatus", user: account, oid: entryRef.cloid }),
    postInfo(fetchImpl, endpoint, { type: "orderStatus", user: account, oid: exitRef.cloid }),
    postInfo(fetchImpl, endpoint, { type: "userFills", user: account, aggregateByTime: false }),
    postInfo(fetchImpl, endpoint, { type: "clearinghouseState", user: account }),
    postInfo(fetchImpl, endpoint, { type: "openOrders", user: account }),
    ...protectionQueries,
  ]);
  if (!Array.isArray(userFills)) throw evidenceError("Hyperliquid user fills response is invalid");
  if (!Array.isArray(state?.assetPositions)) throw evidenceError("Hyperliquid account state is invalid");
  if (!Array.isArray(openOrders)) throw evidenceError("Hyperliquid open orders response is invalid");

  const entryOrder = validateVenueOrder(entryStatus, entryRef, {
    coin,
    side: "B",
    reduceOnly: false,
    phase: "entry",
  });
  const exitOrder = validateVenueOrder(exitStatus, exitRef, {
    coin,
    side: "A",
    reduceOnly: true,
    phase: "exit",
  });
  const entryFill = validateVenueFills(userFills, entryRef, {
    coin,
    side: "B",
    direction: "Open Long",
    phase: "entry",
  });
  const exitFill = validateVenueFills(userFills, exitRef, {
    coin,
    side: "A",
    direction: "Close Long",
    phase: "exit",
  });
  const protectionEvidence = protectionRef ? {
    take_profit: validateVenueProtectionOrder(protectionStatuses[0], protectionRef.takeProfit, coin, "take-profit"),
    stop_loss: validateVenueProtectionOrder(protectionStatuses[1], protectionRef.stopLoss, coin, "stop-loss"),
  } : null;
  if (entryFill.firstFillTimeMs > exitFill.firstFillTimeMs) {
    throw evidenceError("Hyperliquid exit predates entry");
  }
  if (entryFill.notionalUsd < 10 || entryFill.notionalUsd > notionalCap * 1.01 + 0.01) {
    throw evidenceError("Hyperliquid entry notional is outside the proof bound");
  }
  if (entryFill.transactionHashes.some((hash) => exitFill.transactionHashes.includes(hash))) {
    throw evidenceError("Hyperliquid entry and exit transaction hashes are not distinct");
  }
  const position = state.assetPositions
    .map((row) => row?.position || row)
    .find((row) => String(row?.coin || "").toUpperCase() === coin);
  const positionSize = String(position?.szi ?? "0");
  if (!isZeroDecimal(positionSize)) throw evidenceError("Hyperliquid proof account is not flat");
  const marketOpenOrders = openOrders.filter((order) => String(order?.coin || "").toUpperCase() === coin);
  if (marketOpenOrders.length !== 0) throw evidenceError("Hyperliquid proof market still has open orders");

  const verifiedAt = new Date().toISOString();
  return {
    version: 1,
    proof_kind: "hyperliquid_mainnet_public_venue_evidence_v1",
    independently_queried: true,
    network: "mainnet",
    market: coin,
    account_address_commitment: `sha256:${sha256(`hyperliquid_account:${account}`)}`,
    entry: evidenceLeg(entryRef, entryOrder, entryFill, false),
    exit: evidenceLeg(exitRef, exitOrder, exitFill, true),
    entry_exit_sizes_match: true,
    entry_before_exit: true,
    reduce_only_exit_proven: true,
    position_protection_proven: protectionEvidence !== null,
    protection_children_terminal: protectionEvidence !== null,
    ...(protectionEvidence ? { protection: protectionEvidence } : {}),
    transaction_hashes_distinct: true,
    flat_after_exit: true,
    open_orders_after_exit: 0,
    queried_endpoints: protectionEvidence
      ? ["orderStatus:entry", "orderStatus:exit", "orderStatus:take_profit", "orderStatus:stop_loss", "userFills", "clearinghouseState", "openOrders"]
      : ["orderStatus", "userFills", "clearinghouseState", "openOrders"],
    verified_at: verifiedAt,
  };
}

function evidenceLeg(reference, order, fill, reduceOnly) {
  return {
    oid: reference.oid,
    cloid: reference.cloid,
    order_status: "filled",
    side: reduceOnly ? "sell" : "buy",
    reduce_only: reduceOnly,
    original_base_size: order.originalBaseSize,
    filled_base_size: fill.filledBaseSize,
    fill_count: fill.fillCount,
    average_fill_price: fill.averageFillPrice,
    filled_notional_usd: fill.notionalUsd,
    fee_usd: fill.feeUsd,
    fee_token: "USDC",
    transaction_hashes: fill.transactionHashes,
    trade_ids: fill.tradeIds,
    first_fill_time_ms: fill.firstFillTimeMs,
    last_fill_time_ms: fill.lastFillTimeMs,
  };
}

function validateExpectedReference(value, phase) {
  const oid = String(value?.oid || "").trim();
  const cloid = String(value?.cloid || "").trim().toLowerCase();
  const filledBaseSize = String(value?.filled_base_size || "").trim();
  const averageFillPrice = Number(value?.average_fill_price);
  if (!/^\d+$/u.test(oid)) throw evidenceError(`Hyperliquid ${phase} oid is invalid`);
  if (!/^0x[0-9a-f]{32}$/u.test(cloid)) throw evidenceError(`Hyperliquid ${phase} cloid is invalid`);
  if (decimalUnits(filledBaseSize) <= 0n) throw evidenceError(`Hyperliquid ${phase} size is invalid`);
  if (!Number.isFinite(averageFillPrice) || averageFillPrice <= 0) {
    throw evidenceError(`Hyperliquid ${phase} average fill price is invalid`);
  }
  return { oid, cloid, filledBaseSize, averageFillPrice };
}

function validateProtectionReference(value) {
  const read = (leg, phase) => {
    const oid = String(leg?.oid || "").trim();
    const cloid = String(leg?.cloid || "").trim().toLowerCase();
    if (!/^\d+$/u.test(oid) || !/^0x[0-9a-f]{32}$/u.test(cloid)) {
      throw evidenceError(`Hyperliquid ${phase} protection identity is invalid`);
    }
    return { oid, cloid };
  };
  const takeProfit = read(value?.take_profit, "take-profit");
  const stopLoss = read(value?.stop_loss, "stop-loss");
  if (takeProfit.oid === stopLoss.oid || takeProfit.cloid === stopLoss.cloid) {
    throw evidenceError("Hyperliquid protection identities are not distinct");
  }
  return { takeProfit, stopLoss };
}

function validateVenueProtectionOrder(response, reference, coin, phase) {
  if (response?.status !== "order") throw evidenceError(`Hyperliquid ${phase} protection is unavailable`);
  const envelope = response?.order;
  const order = envelope?.order;
  const venueStatus = String(envelope?.status || "").trim();
  const status = venueStatus.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!order || !["canceled", "cancelled", "reduceonlycanceled"].includes(status)) {
    throw evidenceError(`Hyperliquid ${phase} protection is not terminal`);
  }
  if (String(order.oid || "") !== reference.oid ||
      String(order.cloid || "").toLowerCase() !== reference.cloid ||
      String(order.coin || "").toUpperCase() !== coin ||
      String(order.side || "").toUpperCase() !== "A" ||
      order.reduceOnly !== true || order.isTrigger !== true) {
    throw evidenceError(`Hyperliquid ${phase} protection controls mismatch`);
  }
  return {
    oid: reference.oid,
    cloid: reference.cloid,
    order_status: "canceled",
    venue_order_status: venueStatus,
    side: "sell",
    reduce_only: true,
    trigger_order: true,
  };
}

function validateVenueOrder(response, reference, expected) {
  if (response?.status !== "order") throw evidenceError(`Hyperliquid ${expected.phase} order is unavailable`);
  const envelope = response?.order;
  const order = envelope?.order;
  const status = String(envelope?.status || "").trim().toLowerCase();
  if (!order || status !== "filled") throw evidenceError(`Hyperliquid ${expected.phase} order is not filled`);
  if (String(order.oid || "") !== reference.oid || String(order.cloid || "").toLowerCase() !== reference.cloid) {
    throw evidenceError(`Hyperliquid ${expected.phase} order identity mismatch`);
  }
  if (String(order.coin || "").toUpperCase() !== expected.coin || String(order.side || "").toUpperCase() !== expected.side) {
    throw evidenceError(`Hyperliquid ${expected.phase} order market or side mismatch`);
  }
  if (order.reduceOnly !== expected.reduceOnly || String(order.tif || "").toLowerCase() !== "ioc") {
    throw evidenceError(`Hyperliquid ${expected.phase} order controls mismatch`);
  }
  const originalBaseSize = String(order.origSz || "");
  if (decimalUnits(originalBaseSize) !== decimalUnits(reference.filledBaseSize)) {
    throw evidenceError(`Hyperliquid ${expected.phase} order size mismatch`);
  }
  return { originalBaseSize };
}

function validateVenueFills(userFills, reference, expected) {
  const fills = userFills.filter((fill) =>
    String(fill?.oid || "") === reference.oid &&
    String(fill?.cloid || "").toLowerCase() === reference.cloid &&
    String(fill?.coin || "").toUpperCase() === expected.coin);
  if (fills.length === 0) throw evidenceError(`Hyperliquid ${expected.phase} fills are unavailable`);
  let sizeUnits = 0n;
  let notionalUsd = 0;
  let feeUsd = 0;
  const hashes = [];
  const tids = [];
  const times = [];
  for (const fill of fills) {
    const size = String(fill?.sz || "");
    const price = Number(fill?.px);
    const fee = Number(fill?.fee);
    const hash = String(fill?.hash || "").toLowerCase();
    const tid = String(fill?.tid || "");
    const time = Number(fill?.time);
    if (String(fill?.side || "").toUpperCase() !== expected.side || fill?.dir !== expected.direction) {
      throw evidenceError(`Hyperliquid ${expected.phase} fill direction mismatch`);
    }
    if (fill?.crossed !== true || String(fill?.feeToken || "").toUpperCase() !== "USDC") {
      throw evidenceError(`Hyperliquid ${expected.phase} fill execution evidence is invalid`);
    }
    const units = decimalUnits(size);
    if (units <= 0n || !Number.isFinite(price) || price <= 0 || !Number.isFinite(fee) || fee <= 0) {
      throw evidenceError(`Hyperliquid ${expected.phase} fill economics are invalid`);
    }
    if (!/^0x[0-9a-f]{64}$/u.test(hash) || !/^\d+$/u.test(tid) || !Number.isInteger(time) || time <= 0) {
      throw evidenceError(`Hyperliquid ${expected.phase} public fill reference is invalid`);
    }
    sizeUnits += units;
    notionalUsd += Number(size) * price;
    feeUsd += fee;
    hashes.push(hash);
    tids.push(tid);
    times.push(time);
  }
  if (sizeUnits !== decimalUnits(reference.filledBaseSize)) {
    throw evidenceError(`Hyperliquid ${expected.phase} filled size mismatch`);
  }
  const filledBaseSize = decimalText(sizeUnits);
  const averageFillPrice = notionalUsd / Number(filledBaseSize);
  const tolerance = Math.max(1e-8, reference.averageFillPrice * 1e-10);
  if (Math.abs(averageFillPrice - reference.averageFillPrice) > tolerance) {
    throw evidenceError(`Hyperliquid ${expected.phase} average fill price mismatch`);
  }
  return {
    filledBaseSize,
    fillCount: fills.length,
    averageFillPrice: roundMoney(averageFillPrice),
    notionalUsd: roundMoney(notionalUsd),
    feeUsd: roundMoney(feeUsd),
    transactionHashes: [...new Set(hashes)],
    tradeIds: [...new Set(tids)],
    firstFillTimeMs: Math.min(...times),
    lastFillTimeMs: Math.max(...times),
  };
}

async function postInfo(fetchImpl, endpoint, payload) {
  const response = await fetchImpl(`${endpoint}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response?.ok) throw evidenceError("Hyperliquid proof query failed");
  return response.json();
}

function validMainnetBaseUrl(value) {
  const url = new URL(String(value || "https://api.hyperliquid.xyz"));
  if (url.protocol !== "https:" || url.hostname !== "api.hyperliquid.xyz") {
    throw evidenceError("Hyperliquid proof endpoint is not mainnet");
  }
  return url.origin;
}

function decimalUnits(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match || (match[2]?.length || 0) > DECIMAL_SCALE) throw evidenceError("decimal evidence is invalid");
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || "").padEnd(DECIMAL_SCALE, "0"));
  return whole * DECIMAL_FACTOR + fraction;
}

function decimalText(units) {
  const whole = units / DECIMAL_FACTOR;
  const fraction = String(units % DECIMAL_FACTOR).padStart(DECIMAL_SCALE, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function isZeroDecimal(value) {
  const parsed = Number(String(value ?? ""));
  return Number.isFinite(parsed) && Math.abs(parsed) < 1e-12;
}

function roundMoney(value) {
  return Math.round(value * 1e8) / 1e8;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function evidenceError(message) {
  return Object.assign(new Error(message), { status: 502, code: "venue_evidence_unproven" });
}
