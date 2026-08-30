import {
  CARRY_EXECUTION_VENUES,
  venueAdapterCapability,
} from "@ghola/execution-core";

const MAX_LIQUIDATION_DISTANCE_BPS = 100_000;

export const LIQUIDATION_DISTANCE_SOURCES = Object.freeze(Object.fromEntries(
  CARRY_EXECUTION_VENUES.flatMap((venueId) => {
    const source = liquidationDistanceSourceForVenue(venueId);
    return source === null ? [] : [[venueId, source]];
  }),
));

export function hyperliquidLiquidationDistance(state) {
  return liquidationObservation({
    rows: state?.assetPositions,
    source: LIQUIDATION_DISTANCE_SOURCES.hyperliquid,
    decode: (row) => {
      const position = row?.position;
      const signedSize = decimal(position?.szi);
      if (signedSize === null) return null;
      if (signedSize === 0) return { open: false };
      const positionValue = positiveDecimal(position?.positionValue);
      return positionValue === null
        ? { open: true, distance_bps: null }
        : openPosition({
            side: signedSize > 0 ? "long" : "short",
            markPrice: positionValue / Math.abs(signedSize),
            liquidationPrice: positiveDecimal(position?.liquidationPx),
          });
    },
  });
}

export function lighterLiquidationDistance(account) {
  return liquidationObservation({
    rows: account?.positions,
    source: LIQUIDATION_DISTANCE_SOURCES.lighter,
    decode: (row) => {
      const size = nonnegativeDecimal(row?.position);
      if (size === null) return null;
      if (size === 0) return { open: false };
      const sign = Number(row?.sign);
      const positionValue = positiveDecimal(row?.position_value);
      if ((sign !== 1 && sign !== -1) || positionValue === null) return { open: true, distance_bps: null };
      return openPosition({
        side: sign === 1 ? "long" : "short",
        markPrice: positionValue / size,
        liquidationPrice: positiveDecimal(row?.liquidation_price),
      });
    },
  });
}

export function asterLiquidationDistance(positions) {
  return liquidationObservation({
    rows: positions,
    source: LIQUIDATION_DISTANCE_SOURCES.aster,
    decode: (row) => {
      const signedSize = decimal(row?.positionAmt);
      if (signedSize === null) return null;
      if (signedSize === 0) return { open: false };
      return openPosition({
        side: signedSize > 0 ? "long" : "short",
        markPrice: positiveDecimal(row?.markPrice),
        liquidationPrice: positiveDecimal(row?.liquidationPrice),
      });
    },
  });
}

export function liquidationDistanceSourceForVenue(venueId) {
  const source = venueAdapterCapability(String(venueId || ""), "carry_execution")?.liquidation_distance_source;
  return typeof source === "string" && /^[a-z][a-zA-Z0-9_]{7,159}$/.test(source) ? source : null;
}

export function validVenueLiquidationBinding(value, positionCount = value?.position_count) {
  const expectedSource = liquidationDistanceSourceForVenue(value?.venue_id);
  const distance = value?.liquidation_distance_bps;
  const source = value?.liquidation_distance_source;
  const verified = value?.liquidation_distance_verified === true;
  if (!expectedSource || !Number.isSafeInteger(positionCount) || positionCount < 0) return false;
  if (positionCount === 0) return distance === null && !verified && source === null;
  if (!verified) return distance === null && source === null;
  return Number.isSafeInteger(distance)
    && distance >= 0
    && distance <= MAX_LIQUIDATION_DISTANCE_BPS
    && source === expectedSource;
}

function liquidationObservation({ rows, source, decode }) {
  if (!Array.isArray(rows)) return unavailable(null);
  const open = [];
  for (const row of rows) {
    const decoded = decode(row);
    if (!decoded) return unavailable(null);
    if (decoded.open) open.push(decoded);
  }
  if (open.length === 0) return unavailable(0);
  if (open.some((position) => position.distance_bps === null)) return unavailable(open.length);
  return Object.freeze({
    position_count: open.length,
    liquidation_distance_bps: Math.min(...open.map((position) => position.distance_bps)),
    liquidation_distance_verified: true,
    liquidation_distance_source: source,
  });
}

function openPosition({ side, markPrice, liquidationPrice }) {
  if (!Number.isFinite(markPrice) || markPrice <= 0 || liquidationPrice === null) {
    return { open: true, distance_bps: null };
  }
  const adverseGap = side === "long"
    ? markPrice - liquidationPrice
    : liquidationPrice - markPrice;
  const distance = Math.floor(Math.max(0, adverseGap) * 10_000 / markPrice);
  return {
    open: true,
    distance_bps: Number.isSafeInteger(distance) && distance <= MAX_LIQUIDATION_DISTANCE_BPS
      ? distance
      : null,
  };
}

function unavailable(positionCount) {
  return Object.freeze({
    position_count: positionCount,
    liquidation_distance_bps: null,
    liquidation_distance_verified: false,
    liquidation_distance_source: null,
  });
}

function decimal(value) {
  const raw = String(value ?? "");
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveDecimal(value) {
  const parsed = decimal(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonnegativeDecimal(value) {
  const parsed = decimal(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
