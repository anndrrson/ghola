const PRODUCTION_COUNTRY_HEADER = "x-vercel-ip-country";
const TEST_COUNTRY_HEADER = "x-ghola-test-country";

export const LIVE_TRADING_COUNTRY_ALLOWLIST_ENV = "GHOLA_LIVE_TRADING_COUNTRY_ALLOWLIST";

const US_JURISDICTIONS = new Set([
  "AS",
  "GU",
  "MP",
  "PR",
  "UM",
  "US",
  "VI",
]);

export type LiveTradingJurisdictionReason =
  | "allowed"
  | "country_header_invalid"
  | "country_header_missing"
  | "country_not_allowlisted"
  | "jurisdiction_allowlist_invalid"
  | "jurisdiction_allowlist_missing"
  | "restricted_us_jurisdiction"
  | "untrusted_country_source";

export interface LiveTradingJurisdictionDecision {
  allowed: boolean;
  status: 200 | 451;
  country: string | null;
  region: null;
  reason: LiveTradingJurisdictionReason;
  reason_codes: LiveTradingJurisdictionReason[];
  next_step: string;
}

export function evaluateLiveTradingJurisdiction(
  request: Pick<Request, "headers">,
  env: Record<string, string | undefined> = process.env,
): LiveTradingJurisdictionDecision {
  const production = isProductionRuntime(env);
  if (production && !isTrustedVercelProduction(env)) {
    return denied("untrusted_country_source", null);
  }

  const rawCountry = request.headers.get(
    production ? PRODUCTION_COUNTRY_HEADER : TEST_COUNTRY_HEADER,
  );
  if (!rawCountry?.trim()) return denied("country_header_missing", null);

  const country = normalizeCountryCode(rawCountry);
  if (!country) return denied("country_header_invalid", null);
  if (US_JURISDICTIONS.has(country)) {
    return denied("restricted_us_jurisdiction", country);
  }

  const configured = configuredCountryAllowlist(env);
  if (!configured.ok) return denied(configured.reason, country);
  if (!configured.countries.has(country)) {
    return denied("country_not_allowlisted", country);
  }

  return {
    allowed: true,
    status: 200,
    country,
    region: null,
    reason: "allowed",
    reason_codes: ["allowed"],
    next_step: "Live trading is available in this jurisdiction.",
  };
}

export function liveTradingJurisdictionErrorBody(
  decision: LiveTradingJurisdictionDecision,
) {
  return {
    error: "restricted_jurisdiction",
    reason: decision.reason,
    reason_codes: decision.reason_codes,
  };
}

export function isLiveTradingCountryAllowlisted(
  value: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const country = typeof value === "string" ? normalizeCountryCode(value) : null;
  if (!country || US_JURISDICTIONS.has(country)) return false;
  const configured = configuredCountryAllowlist(env);
  return configured.ok && configured.countries.has(country);
}

function configuredCountryAllowlist(
  env: Record<string, string | undefined>,
):
  | { ok: true; countries: Set<string> }
  | { ok: false; reason: "jurisdiction_allowlist_invalid" | "jurisdiction_allowlist_missing" } {
  const raw = env[LIVE_TRADING_COUNTRY_ALLOWLIST_ENV]?.trim() ?? "";
  if (!raw) return { ok: false, reason: "jurisdiction_allowlist_missing" };

  const values = raw.split(",").map((value) => value.trim().toUpperCase());
  if (!values.length || values.some((value) => !/^[A-Z]{2}$/.test(value))) {
    return { ok: false, reason: "jurisdiction_allowlist_invalid" };
  }
  return { ok: true, countries: new Set(values) };
}

function isProductionRuntime(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV?.trim().toLowerCase() === "production";
}

function isTrustedVercelProduction(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === "1" && env.VERCEL_ENV?.trim().toLowerCase() === "production";
}

function normalizeCountryCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function denied(
  reason: Exclude<LiveTradingJurisdictionReason, "allowed">,
  country: string | null,
): LiveTradingJurisdictionDecision {
  return {
    allowed: false,
    status: 451,
    country,
    region: null,
    reason,
    reason_codes: [reason],
    next_step: nextStep(reason),
  };
}

function nextStep(reason: Exclude<LiveTradingJurisdictionReason, "allowed">): string {
  switch (reason) {
    case "country_header_invalid":
    case "country_header_missing":
    case "untrusted_country_source":
      return "Live trading is unavailable because jurisdiction could not be verified.";
    case "jurisdiction_allowlist_invalid":
    case "jurisdiction_allowlist_missing":
      return "Live trading is unavailable because licensed territories are not configured.";
    case "country_not_allowlisted":
    case "restricted_us_jurisdiction":
      return "Live trading is unavailable in this jurisdiction.";
  }
}
