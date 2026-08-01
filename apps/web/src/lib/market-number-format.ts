export function formatUsdPrice(
  value: string | number | null | undefined,
  quoteIncrement?: string | null,
): string {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const decimals = quoteIncrementDecimals(quoteIncrement) ?? magnitudePriceDecimals(number);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(number);
}

export function formatCompactUsd(value: string | number | null | undefined): string {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(number) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(number) >= 10_000 ? 1 : 2,
  }).format(number);
}

export function formatAssetQuantity(
  value: string | number | null | undefined,
  maximumFractionDigits = 6,
): string {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(number);
}

export function formatSignedPercent(
  value: string | number | null | undefined,
  fractionDigits = 2,
): string {
  if (value == null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    signDisplay: "exceptZero",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(number / 100);
}

function quoteIncrementDecimals(value?: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const fraction = value.split(".")[1] || "";
  const lastSignificant = fraction.search(/[1-9]/);
  return lastSignificant < 0 ? 0 : Math.min(8, lastSignificant + 1);
}

function magnitudePriceDecimals(value: number): number {
  if (Math.abs(value) >= 100) return 2;
  if (Math.abs(value) >= 1) return 4;
  return 6;
}
