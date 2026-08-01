export type GholaProductEnvironment = "production" | "testnet";
export type HyperliquidProductNetwork = "mainnet" | "testnet";

export function resolveGholaProductEnvironment(input: {
  host?: string | null;
  configuredEnvironment?: string | null;
  configuredHyperliquidNetwork?: string | null;
}): {
  environment: GholaProductEnvironment;
  hyperliquidNetwork: HyperliquidProductNetwork;
} {
  const hostname = normalizeHostname(input.host);
  const explicitTestnet = input.configuredEnvironment?.trim().toLowerCase() === "testnet";
  const testnetHost = hostname === "testnet.ghola.xyz" || hostname.endsWith(".testnet.ghola.xyz");
  const environment: GholaProductEnvironment = explicitTestnet || testnetHost
    ? "testnet"
    : "production";
  const configuredNetwork = input.configuredHyperliquidNetwork?.trim().toLowerCase();
  const hyperliquidNetwork: HyperliquidProductNetwork = environment === "testnet"
    ? "testnet"
    : configuredNetwork === "testnet"
      ? "testnet"
      : "mainnet";

  return { environment, hyperliquidNetwork };
}

function normalizeHostname(host?: string | null): string {
  const value = host?.trim().toLowerCase() ?? "";
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(1, end) : value;
  }
  return value.split(":", 1)[0];
}
