const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const EVM_TRANSACTION_HASH = /^0x[0-9a-f]{64}$/i;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

export const LIGHTER_DEPOSIT_DEFAULT_USDC = "5.5";
export const LIGHTER_DEPOSIT_MINIMUM_USDC = "5";
export const LIGHTER_DEPOSIT_MINIMUM_MICROUNITS = "5000000";
export const LIGHTER_DEPOSIT_BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const LIGHTER_DEPOSIT_L1_USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

export type LighterDepositReconciliationStatus = "unseen" | "PROCESSING" | "COMPLETED";

export type LighterDepositReconciliation = Readonly<{
  version: 1;
  expectation_id: string;
  owner_address: `0x${string}`;
  deposit_address: `0x${string}`;
  transaction_hash: `0x${string}`;
  expected_amount_microunits: string;
  status: LighterDepositReconciliationStatus;
  reconciliation_complete: boolean;
  checked_at: string;
}>;

export class LighterDepositReconciliationError extends Error {
  readonly retryForbidden: boolean;

  constructor(message: string, retryForbidden = false) {
    super(message);
    this.name = "LighterDepositReconciliationError";
    this.retryForbidden = retryForbidden;
  }
}

export function lighterUsdcToMicrounits(value: string) {
  const normalized = value.trim();
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(normalized);
  if (!match || normalized.length > 40) return null;
  const microunits = BigInt(`${match[1]}${(match[2] || "").padEnd(6, "0")}`).toString();
  return BigInt(microunits) >= BigInt(LIGHTER_DEPOSIT_MINIMUM_MICROUNITS) ? microunits : null;
}

export async function checkLighterDepositReconciliation({
  ownerAddress,
  depositAddress,
  transactionHash,
  expectedAmountMicrounits,
  fetchImpl = fetch,
}: {
  ownerAddress: string;
  depositAddress: string;
  transactionHash: string;
  expectedAmountMicrounits: string;
  fetchImpl?: typeof fetch;
}): Promise<LighterDepositReconciliation> {
  const owner = validatedAddress(ownerAddress);
  const deposit = validatedAddress(depositAddress);
  const hash = validatedTransactionHash(transactionHash);
  const amount = validatedExpectedAmount(expectedAmountMicrounits);
  let response: Response;
  try {
    response = await fetchImpl("/api/carry/lighter-deposit-reconciliation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        version: 1,
        owner_address: owner,
        deposit_address: deposit,
        transaction_hash: hash,
        expected_amount_microunits: amount,
      }),
    });
  } catch {
    throw ambiguousCheckError();
  }

  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    if (response.status >= 500) throw ambiguousCheckError();
    throw new LighterDepositReconciliationError(
      response.status === 401
        ? "Sign in again before checking this deposit."
        : response.status === 409
          ? "This transaction is already bound to a different deposit expectation."
          : "The deposit check was rejected. Verify the exact Base transaction hash and USDC amount.",
    );
  }

  try {
    return validatedReconciliation(body, response.status, {
      owner,
      deposit,
      hash,
      amount,
    });
  } catch {
    throw ambiguousCheckError();
  }
}

function validatedReconciliation(
  value: unknown,
  responseStatus: number,
  expected: {
    owner: `0x${string}`;
    deposit: `0x${string}`;
    hash: `0x${string}`;
    amount: string;
  },
): LighterDepositReconciliation {
  const body = object(value);
  const expectationId = text(body.expectation_id);
  const checkedAt = text(body.checked_at);
  if (
    body.version !== 1 ||
    !/^lighter_deposit_expectation_[0-9a-f]{48}$/.test(expectationId) ||
    !Number.isFinite(Date.parse(checkedAt))
  ) throw new Error("invalid response");

  if (body.observed === false) {
    if (
      responseStatus !== 202 ||
      body.reconciliation_complete !== false ||
      !Number.isSafeInteger(body.poll_after_ms) ||
      Number(body.poll_after_ms) <= 0
    ) throw new Error("invalid unseen response");
    return Object.freeze({
      version: 1,
      expectation_id: expectationId,
      owner_address: expected.owner,
      deposit_address: expected.deposit,
      transaction_hash: expected.hash,
      expected_amount_microunits: expected.amount,
      status: "unseen",
      reconciliation_complete: false,
      checked_at: checkedAt,
    });
  }

  const source = object(body.source);
  const destination = object(body.destination);
  const status = body.status;
  if (
    responseStatus !== 200 ||
    body.observed !== true ||
    (status !== "PROCESSING" && status !== "COMPLETED") ||
    body.reconciliation_complete !== (status === "COMPLETED") ||
    !sameAddress(body.owner_address, expected.owner) ||
    !sameAddress(body.deposit_address, expected.deposit) ||
    text(body.transaction_hash).toLowerCase() !== expected.hash ||
    body.expected_amount_microunits !== expected.amount ||
    source.chain_id !== 8453 ||
    !sameAddress(source.token_address, LIGHTER_DEPOSIT_BASE_USDC_ADDRESS) ||
    destination.to_chain_id !== "3586256" ||
    !sameAddress(destination.to_token_address, LIGHTER_DEPOSIT_L1_USDC_ADDRESS) ||
    !Number.isSafeInteger(body.provider_created_time_ms) ||
    Number(body.provider_created_time_ms) <= 0
  ) throw new Error("invalid observed response");

  return Object.freeze({
    version: 1,
    expectation_id: expectationId,
    owner_address: expected.owner,
    deposit_address: expected.deposit,
    transaction_hash: expected.hash,
    expected_amount_microunits: expected.amount,
    status,
    reconciliation_complete: status === "COMPLETED",
    checked_at: checkedAt,
  });
}

function validatedAddress(value: string): `0x${string}` {
  if (!EVM_ADDRESS.test(value)) throw new LighterDepositReconciliationError("A verified deposit address is required.");
  return value.toLowerCase() as `0x${string}`;
}

function validatedTransactionHash(value: string): `0x${string}` {
  const normalized = value.trim().toLowerCase();
  if (!EVM_TRANSACTION_HASH.test(normalized)) {
    throw new LighterDepositReconciliationError("Enter the exact Base transaction hash.");
  }
  return normalized as `0x${string}`;
}

function validatedExpectedAmount(value: string) {
  if (
    !DECIMAL_INTEGER.test(value) ||
    value.length > 46 ||
    BigInt(value) < BigInt(LIGHTER_DEPOSIT_MINIMUM_MICROUNITS)
  ) throw new LighterDepositReconciliationError("Expected USDC amount must be at least 5.");
  return value;
}

function ambiguousCheckError() {
  return new LighterDepositReconciliationError(
    "The check outcome is uncertain. Do not submit it again; reconcile this exact transaction manually.",
    true,
  );
}

function sameAddress(value: unknown, expected: string) {
  return typeof value === "string" && EVM_ADDRESS.test(value) && value.toLowerCase() === expected.toLowerCase();
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
