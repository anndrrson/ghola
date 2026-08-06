const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HYPERLIQUID_API = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const;

export type HyperliquidFundingCheckStatus = "pass" | "blocked";

export interface HyperliquidFundingPreflightResult {
  version: 1;
  network: "mainnet" | "testnet";
  status: "identity_ready_for_official_deposit" | "ready_to_trade" | "blocked";
  identity_ready_for_official_deposit: boolean;
  ready_for_no_submit_verification: boolean;
  ready_to_trade: boolean;
  checks: Array<{
    id: "network" | "master_account" | "wallet_match" | "api_wallet" | "account_mode" | "collateral" | "markets";
    status: HyperliquidFundingCheckStatus;
    label: string;
    detail: string;
  }>;
  deposit_route: {
    asset: "native USDC";
    source_network: "Arbitrum";
    destination: "official Hyperliquid deposit flow";
    credited_account: "master account";
    minimum_usdc: 5;
    api_wallet_receives_funds: false;
  };
}

export async function inspectHyperliquidFundingPreflight(input: {
  network: "mainnet" | "testnet";
  masterAccountAddress: string;
  connectedWalletAddress: string;
  apiWalletAddress: string;
  fetchImpl?: typeof fetch;
}): Promise<HyperliquidFundingPreflightResult> {
  const master = normalizedAddress(input.masterAccountAddress, "master account address");
  const connected = normalizedAddress(input.connectedWalletAddress, "connected wallet address");
  const agent = normalizedAddress(input.apiWalletAddress, "API wallet address");
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = HYPERLIQUID_API[input.network];
  const [masterRole, agentRole, abstraction, spotState, perpState, meta] = await Promise.all([
    postInfo(fetchImpl, baseUrl, { type: "userRole", user: master }),
    postInfo(fetchImpl, baseUrl, { type: "userRole", user: agent }),
    postInfo(fetchImpl, baseUrl, { type: "userAbstraction", user: master }),
    postInfo(fetchImpl, baseUrl, { type: "spotClearinghouseState", user: master }),
    postInfo(fetchImpl, baseUrl, { type: "clearinghouseState", user: master }),
    postInfo(fetchImpl, baseUrl, { type: "meta" }),
  ]);

  const walletMatches = master === connected;
  const masterRecognized = masterRole?.role === "user" || masterRole?.role === "subAccount";
  const authorizedMaster = typeof agentRole?.data?.user === "string"
    ? agentRole.data.user.toLowerCase()
    : null;
  const agentAuthorized = agentRole?.role === "agent" && authorizedMaster === master;
  const accountMode = typeof abstraction === "string" ? abstraction : "default";
  const modeRecognized = ["unifiedAccount", "portfolioMargin", "disabled", "default"].includes(accountMode);
  const collateral = collateralValue({ accountMode, spotState, perpState });
  const collateralReady = collateral >= 5;
  const marketNames = new Set(
    (Array.isArray(meta?.universe) ? meta.universe : []).map((market: { name?: unknown }) => String(market?.name || "").toUpperCase()),
  );
  const requiredMarkets = ["BTC", "ETH", "SOL"];
  const marketsReady = requiredMarkets.every((market) => marketNames.has(market));
  const identityReady = input.network === "mainnet" && masterRecognized && walletMatches && modeRecognized && marketsReady;
  const readyForNoSubmit = identityReady && agentAuthorized;
  const readyToTrade = readyForNoSubmit && collateralReady;

  return {
    version: 1,
    network: input.network,
    status: readyToTrade
      ? "ready_to_trade"
      : identityReady
        ? "identity_ready_for_official_deposit"
        : "blocked",
    identity_ready_for_official_deposit: identityReady,
    ready_for_no_submit_verification: readyForNoSubmit,
    ready_to_trade: readyToTrade,
    checks: [
      check("network", input.network === "mainnet", "Mainnet selected", input.network === "mainnet" ? "Official Hyperliquid mainnet API." : "Testnet funds cannot validate a mainnet deposit."),
      check("master_account", masterRecognized, "Master account recognized", masterRecognized ? "Hyperliquid recognizes this account identity." : "Hyperliquid does not recognize this as a user or subaccount."),
      check("wallet_match", walletMatches, "Connected wallet matches", walletMatches ? "The wallet address and master account are identical." : "Do not deposit: the connected wallet and master account differ."),
      check("api_wallet", agentAuthorized, "API wallet authorization", agentAuthorized ? "This signer is authorized for the selected master on mainnet." : "Authorize a dedicated API wallet on mainnet; testnet authorization does not carry over."),
      check("account_mode", modeRecognized, `Account mode: ${accountMode}`, modeRecognized ? collateralSourceDetail(accountMode) : "Ghola does not recognize this account mode."),
      check("collateral", collateralReady, `USDC collateral: ${collateralBucket(collateral)}`, collateralReady ? "At least 5 USDC is available to the account mode Ghola will read." : "No readiness-level USDC collateral is available."),
      check("markets", marketsReady, "Required markets available", marketsReady ? "BTC, ETH, and SOL perps are present." : "A required perp market is unavailable."),
    ],
    deposit_route: {
      asset: "native USDC",
      source_network: "Arbitrum",
      destination: "official Hyperliquid deposit flow",
      credited_account: "master account",
      minimum_usdc: 5,
      api_wallet_receives_funds: false,
    },
  };
}

async function postInfo(fetchImpl: typeof fetch, baseUrl: string, body: Record<string, unknown>) {
  const url = `${baseUrl}/info`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Hyperliquid read-only preflight is unavailable");
  return response.json();
}

function normalizedAddress(value: string, label: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!ADDRESS_RE.test(normalized)) throw new Error(`${label} must be a 20-byte EVM address`);
  return normalized;
}

function collateralValue(input: { accountMode: string; spotState: unknown; perpState: unknown }) {
  const spotState = record(input.spotState);
  if (input.accountMode === "unifiedAccount" || input.accountMode === "portfolioMargin") {
    const maintenance = spotState.tokenToAvailableAfterMaintenance;
    const available = Array.isArray(maintenance)
      ? maintenance.find((item: unknown) => Array.isArray(item) && Number(item[0]) === 0)?.[1]
      : null;
    if (available != null) return finiteNumber(available);
    const balances = spotState.balances;
    const usdc = Array.isArray(balances)
      ? record(balances.find((balance: unknown) => {
          const item = record(balance);
          return item.coin === "USDC" || Number(item.token) === 0;
        }))
      : null;
    return Math.max(0, finiteNumber(usdc?.total) - finiteNumber(usdc?.hold));
  }
  const perpState = record(input.perpState);
  return finiteNumber(record(perpState.marginSummary).accountValue ?? record(perpState.crossMarginSummary).accountValue);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function collateralBucket(value: number) {
  if (value <= 0) return "none";
  if (value < 5) return "under 5 USDC";
  if (value < 25) return "5–25 USDC";
  if (value < 100) return "25–100 USDC";
  return "100+ USDC";
}

function collateralSourceDetail(mode: string) {
  return mode === "unifiedAccount" || mode === "portfolioMargin"
    ? "Ghola will read available spot USDC as shared perp collateral."
    : "Ghola will read the validator-operated perps account value.";
}

function check(id: HyperliquidFundingPreflightResult["checks"][number]["id"], passed: boolean, label: string, detail: string) {
  return { id, status: passed ? "pass" as const : "blocked" as const, label, detail };
}
