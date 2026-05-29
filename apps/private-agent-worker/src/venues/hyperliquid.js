import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAINNET_API_URL = "https://api.hyperliquid.xyz";
const TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";

export class HyperliquidExecutionError extends Error {
  constructor(message, status = 502, code = "connector_submit_failed") {
    super(message);
    this.name = "HyperliquidExecutionError";
    this.status = status;
    this.code = code;
  }
}

export function hyperliquidCredentialFromVault(vault) {
  if (!vault || typeof vault !== "object") {
    throw new HyperliquidExecutionError("hyperliquid execution vault is invalid", 400, "venue_access_required");
  }
  if (vault.kind !== "ghola_hyperliquid_execution_vault") {
    throw new HyperliquidExecutionError("hyperliquid execution vault kind is invalid", 400, "venue_access_required");
  }
  if (!vault.hyperliquid_account_address || !vault.api_wallet_private_key) {
    throw new HyperliquidExecutionError("hyperliquid execution credentials are missing", 400, "venue_access_required");
  }
  return {
    network: vault.network === "testnet" ? "testnet" : "mainnet",
    base_url: vault.network === "testnet" ? TESTNET_API_URL : MAINNET_API_URL,
    account_address: String(vault.hyperliquid_account_address).toLowerCase(),
    api_wallet_private_key: String(vault.api_wallet_private_key).toLowerCase(),
    agent_name: vault.agent_name || null,
  };
}

export function assertHyperliquidPilotNetwork(credential, instruction = null) {
  const network = credential?.network === "testnet" ? "testnet" : "mainnet";
  if (network === "testnet") return;
  if (process.env.PRIVATE_AGENT_HYPERLIQUID_ALLOW_MAINNET !== "true") {
    throw new HyperliquidExecutionError("hyperliquid pilot is testnet-only unless live mainnet is explicitly enabled", 400);
  }
  const liveMode = process.env.PRIVATE_AGENT_HYPERLIQUID_LIVE_MODE || "disabled";
  const operationClass = instruction?.operation_class || "read";
  if (operationClass === "read" || operationClass === "reconcile") {
    if (liveMode === "read_only" || liveMode === "tiny_fill") return;
    throw new HyperliquidExecutionError("hyperliquid mainnet read mode is disabled", 400);
  }
  if (operationClass === "cancel") {
    if (liveMode === "tiny_fill") return;
    throw new HyperliquidExecutionError("hyperliquid mainnet cancel mode is disabled", 400);
  }
  if (operationClass !== "limit_order" || liveMode !== "tiny_fill") {
    throw new HyperliquidExecutionError("hyperliquid mainnet submit requires tiny_fill live mode", 400);
  }
  const order = instruction?.order || {};
  if (order.live_order_mode !== "tiny_fill" || order.tif !== "Ioc" || !order.quote_size) {
    throw new HyperliquidExecutionError("hyperliquid mainnet order must use tiny_fill IOC quote sizing", 400);
  }
}

export function hyperliquidManagedAccountRefs() {
  return managedHyperliquidAccounts().map((account, index) => ({
    credential_ref: managedCredentialRef(account, index),
    network: account.network === "mainnet" ? "mainnet" : "testnet",
    market_allowlist: Array.isArray(account.market_allowlist)
      ? account.market_allowlist.map((market) => String(market).toUpperCase())
      : [],
  }));
}

export function loadManagedHyperliquidCredential(allocation) {
  if (allocation?.network !== "testnet") {
    throw new HyperliquidExecutionError("hyperliquid managed pilot is testnet-only", 400);
  }
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      network: "testnet",
      base_url: TESTNET_API_URL,
      account_address: "0x0000000000000000000000000000000000000001",
      api_wallet_private_key: "0x1111111111111111111111111111111111111111111111111111111111111111",
      agent_name: "dry-run-managed",
    };
  }
  const accounts = managedHyperliquidAccounts();
  const selected = accounts.find((account, index) =>
    managedCredentialRef(account, index) === allocation.credential_ref
  );
  if (!selected) {
    throw new HyperliquidExecutionError("hyperliquid managed allocation credential is unavailable", 503);
  }
  const credential = {
    network: selected.network === "testnet" ? "testnet" : "mainnet",
    base_url: selected.network === "testnet" ? TESTNET_API_URL : MAINNET_API_URL,
    account_address: String(selected.account_address || "").toLowerCase(),
    api_wallet_private_key: String(selected.api_wallet_private_key || "").toLowerCase(),
    agent_name: selected.agent_name || "managed-testnet",
  };
  if (!/^0x[0-9a-f]{40}$/i.test(credential.account_address)) {
    throw new HyperliquidExecutionError("hyperliquid managed account address is invalid", 503);
  }
  if (!/^0x[0-9a-f]{64}$/i.test(credential.api_wallet_private_key)) {
    throw new HyperliquidExecutionError("hyperliquid managed API wallet key is invalid", 503);
  }
  assertHyperliquidPilotNetwork(credential);
  return credential;
}

export async function submitHyperliquidExecution({
  credential,
  instruction,
  cloid,
  runner = defaultRunner,
}) {
  assertHyperliquidPilotNetwork(credential, instruction);
  if (process.env.PRIVATE_AGENT_VENUE_DRY_RUN === "true") {
    return {
      status: instruction.operation_class === "cancel" ? "cancelled" : "submitted",
      provider_ref_seed: { venue: "hyperliquid", cloid, dry_run: true },
      result_seed: { kind: "hyperliquid_dry_run", market: instruction.order?.market || instruction.cancel?.market || null },
    };
  }
  const result = await runner({
    credential,
    instruction,
    cloid,
    timeout_ms: Number.parseInt(process.env.PRIVATE_AGENT_HYPERLIQUID_TIMEOUT_MS || "12000", 10),
  });
  return {
    status: result.status || (instruction.operation_class === "cancel" ? "cancelled" : "submitted"),
    provider_ref_seed: {
      venue: "hyperliquid",
      cloid,
      oid: result.oid || null,
      fills_count: Array.isArray(result.fills) ? result.fills.length : 0,
    },
    result_seed: {
      kind: "hyperliquid_result",
      status: result.status || "submitted",
      market: instruction.order?.market || instruction.cancel?.market || null,
    },
    fills: Array.isArray(result.fills) ? result.fills.slice(0, 25) : [],
  };
}

function managedHyperliquidAccounts() {
  const raw = process.env.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_JSON ||
    readManagedAccountsPath();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HyperliquidExecutionError("hyperliquid managed account pool is invalid JSON", 503);
  }
  const accounts = Array.isArray(parsed) ? parsed : parsed.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new HyperliquidExecutionError("hyperliquid managed account pool is empty", 503);
  }
  return accounts.map((account) => ({
    ...account,
    network: account.network === "mainnet" ? "mainnet" : "testnet",
  }));
}

function readManagedAccountsPath() {
  const path = process.env.PRIVATE_AGENT_HYPERLIQUID_MANAGED_ACCOUNTS_PATH;
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new HyperliquidExecutionError("hyperliquid managed account pool is unreadable", 503);
  }
}

function managedCredentialRef(account, index) {
  return `hyperliquid_managed_credential_${sha256Hex(JSON.stringify({
    index,
    network: account.network === "mainnet" ? "mainnet" : "testnet",
    account_address: String(account.account_address || "").toLowerCase(),
    agent_name: account.agent_name || null,
  })).slice(0, 48)}`;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultRunner(payload) {
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "hyperliquid_runner.py");
  const python = process.env.PRIVATE_AGENT_PYTHON || "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, [runnerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HyperliquidExecutionError("hyperliquid runner timed out", 504));
    }, payload.timeout_ms || 12000);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new HyperliquidExecutionError(error.message || "hyperliquid runner failed", 502));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const text = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) {
        const parsed = parseRunnerFailure(text);
        reject(new HyperliquidExecutionError(
          parsed.message,
          parsed.status,
          parsed.code,
        ));
        return;
      }
      try {
        resolve(JSON.parse(text || "{}"));
      } catch {
        reject(new HyperliquidExecutionError("hyperliquid runner returned invalid JSON", 502));
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function parseRunnerFailure(text) {
  try {
    const body = JSON.parse(text || "{}");
    const message = typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : "hyperliquid runner failed";
    const code = body.error_code === "venue_rejected"
      ? "venue_rejected"
      : body.error_code === "venue_access_required"
        ? "venue_access_required"
        : "connector_submit_failed";
    const status = code === "venue_rejected" ? 422 : code === "venue_access_required" ? 400 : 502;
    return { message, code, status };
  } catch {
    return {
      message: "hyperliquid runner failed",
      code: "connector_submit_failed",
      status: 502,
    };
  }
}
