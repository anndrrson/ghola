import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHyperliquidExecutionVault,
  createHyperliquidManagedAllocation,
  createPrivateExecutionAccount,
  gholaCommitment,
  type GholaHyperliquidConnectionProof,
  type GholaHyperliquidExecutionVault,
} from "./private-account";
import {
  putHyperliquidExecutionVault,
  putHyperliquidManagedAllocation,
  putPrivateAccountRecord,
  resetPrivateAccountStoreForTests,
} from "./private-account-store";
import {
  controlAutonomousAutopilotSessionFromBody,
  createAutonomousAutopilotSessionFromBody,
} from "./private-account-autopilot";
import { verifiedHyperliquidVenueAccessForBoundedRun } from "./private-account-bounded-run-venue-access.server";

const NOW = new Date("2026-08-30T12:05:00.000Z");
const CREATED_AT = "2026-08-30T12:00:00.000Z";
const WORKER_ENV = {
  GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
  GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "test-token",
};
const mobileOwner = {
  owner_commitment: "owner_mobile_hyperliquid",
  user: {
    id: "owner_mobile_hyperliquid",
    email: "mobile@example.com",
  },
};

describe("verified bounded-Run Hyperliquid handoff", () => {
  beforeEach(async () => {
    await resetPrivateAccountStoreForTests();
  });

  afterEach(async () => {
    await resetPrivateAccountStoreForTests();
  });

  it("hands the exact owner-bound sealed vault to the worker", async () => {
    const account = await storeAccount(mobileOwner.owner_commitment);
    const vault = await storeVault(mobileOwner.owner_commitment, account.account_commitment);

    const access = await verifiedHyperliquidVenueAccessForBoundedRun(mobileOwner, NOW);

    expect(access).toMatchObject({
      hyperliquid: {
        status: "ready",
        execution_mode: "byo_api_key",
        network: "testnet",
        account_commitment: account.account_commitment,
        vault_commitment: vault.vault_commitment,
        encrypted_vault_commitment: vault.encrypted_vault_commitment,
        policy_commitment: vault.policy_commitment,
      },
    });
    expect((access.hyperliquid as { encrypted_execution_vault: unknown }).encrypted_execution_vault)
      .toEqual(vault.encrypted_execution_vault);
  });

  it("hands an exact verified managed allocation to the worker", async () => {
    const account = await storeAccount(mobileOwner.owner_commitment);
    const stored = await storeAllocation(mobileOwner.owner_commitment, account.account_commitment);

    const access = await verifiedHyperliquidVenueAccessForBoundedRun(mobileOwner, NOW);

    expect(access).toEqual({
      hyperliquid: {
        status: "ready",
        execution_mode: "managed_testnet",
        network: "testnet",
        account_commitment: account.account_commitment,
        allocation_commitment: stored.allocation_commitment,
        managed_allocation_commitment: stored.allocation_commitment,
        policy_commitment: stored.policy_commitment,
        reason: "verified_hyperliquid_allocation_ready",
      },
    });
  });

  it("does not fall back to a vault when the active allocation is unverified", async () => {
    const account = await storeAccount(mobileOwner.owner_commitment);
    await storeVault(mobileOwner.owner_commitment, account.account_commitment);
    await storeAllocation(mobileOwner.owner_commitment, account.account_commitment, null);

    await expect(verifiedHyperliquidVenueAccessForBoundedRun(mobileOwner, NOW)).resolves.toEqual({});
  });

  it.each([
    ["missing proof", null, "sealed", mobileOwner.owner_commitment],
    ["expired proof", connectionProof({ expires_at: "2026-08-30T12:04:59.000Z" }), "sealed", mobileOwner.owner_commitment],
    ["stale vault", connectionProof(), "stale", mobileOwner.owner_commitment],
    ["wrong owner", connectionProof(), "sealed", "owner_attacker"],
  ] as const)("fails closed for %s", async (_label, proof, status, recordOwner) => {
    const account = await storeAccount(mobileOwner.owner_commitment);
    await storeVault(mobileOwner.owner_commitment, account.account_commitment, {
      proof,
      status,
      recordOwner,
    });

    await expect(verifiedHyperliquidVenueAccessForBoundedRun(mobileOwner, NOW)).resolves.toEqual({});
  });

  it("ignores mobile-supplied access, keeps ciphertext private, and leaves pause/kill bodies empty", async () => {
    const account = await storeAccount(mobileOwner.owner_commitment);
    const vault = await storeVault(mobileOwner.owner_commitment, account.account_commitment);
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl = workerFetch(requests);

    const created = await createAutonomousAutopilotSessionFromBody({
      session_policy: {
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
      },
      venue_access: {
        hyperliquid: {
          status: "ready",
          execution_mode: "byo_api_key",
          encrypted_execution_vault: {
            alg: "sealed-provider-v1",
            ciphertext: "attacker-ciphertext",
            recipient: "attacker-recipient",
            aad: "attacker-aad",
          },
        },
      },
    }, mobileOwner, NOW, WORKER_ENV, fetchImpl);

    const workerPayload = JSON.parse(requests[0].body) as {
      session_policy: { max_notional_bucket: string; execution_network: string };
      venue_access: { hyperliquid: { network: string; encrypted_execution_vault: { ciphertext: string } } };
    };
    expect(workerPayload.session_policy.max_notional_bucket).toBe("5");
    expect(workerPayload.session_policy.execution_network).toBe("testnet");
    expect(workerPayload.venue_access.hyperliquid.network).toBe("testnet");
    expect(workerPayload.venue_access.hyperliquid.encrypted_execution_vault)
      .toEqual(vault.encrypted_execution_vault);
    expect(workerPayload.venue_access.hyperliquid.encrypted_execution_vault.ciphertext)
      .not.toBe("attacker-ciphertext");
    expect(JSON.stringify(created)).not.toContain(vault.encrypted_execution_vault.ciphertext);
    expect(JSON.stringify(created)).not.toContain("encrypted_execution_vault");

    await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "pause",
      mobileOwner,
      NOW,
      WORKER_ENV,
      fetchImpl,
    );
    await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "kill",
      mobileOwner,
      NOW,
      WORKER_ENV,
      fetchImpl,
    );

    expect(requests.map((request) => request.url)).toEqual([
      "https://worker.example/autopilot/sessions",
      "https://worker.example/autopilot/sessions/worker_hyperliquid/pause",
      "https://worker.example/autopilot/sessions/worker_hyperliquid/kill",
    ]);
    expect(requests.slice(1).map((request) => request.body)).toEqual(["{}", "{}"]);
    expect(requests.slice(1).some((request) => request.body.includes(vault.encrypted_execution_vault.ciphertext)))
      .toBe(false);
  });

  it("does not forward caller-supplied Hyperliquid access without a verified stored credential", async () => {
    await storeAccount(mobileOwner.owner_commitment);
    const requests: Array<{ url: string; body: string }> = [];

    await createAutonomousAutopilotSessionFromBody({
      session_policy: {
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
      },
      venue_access: {
        hyperliquid: {
          status: "ready",
          encrypted_execution_vault: {
            alg: "sealed-provider-v1",
            ciphertext: "attacker-only-ciphertext",
            recipient: "attacker-recipient",
            aad: "attacker-aad",
          },
        },
      },
    }, mobileOwner, NOW, WORKER_ENV, workerFetch(requests));

    const workerPayload = JSON.parse(requests[0].body) as { venue_access: Record<string, unknown> };
    expect(workerPayload.venue_access).toEqual({});
    expect(requests[0].body).not.toContain("attacker-only-ciphertext");
  });

  it("keeps an expired proof paused and sends fresh access only after reverification", async () => {
    const account = await storeAccount(mobileOwner.owner_commitment);
    await storeVault(mobileOwner.owner_commitment, account.account_commitment);
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl = workerFetch(requests);
    const created = await createAutonomousAutopilotSessionFromBody({
      session_policy: {
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
      },
    }, mobileOwner, NOW, WORKER_ENV, fetchImpl);
    await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "pause",
      mobileOwner,
      new Date("2026-08-30T12:06:00.000Z"),
      WORKER_ENV,
      fetchImpl,
    );

    const expired = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "resume",
      mobileOwner,
      new Date("2026-08-30T12:15:00.001Z"),
      WORKER_ENV,
      fetchImpl,
    );
    expect(expired).toMatchObject({
      error: "hyperliquid_verification_required",
      session: { status: "paused", execution_enabled: false },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://worker.example/autopilot/sessions",
      "https://worker.example/autopilot/sessions/worker_hyperliquid/pause",
    ]);

    await storeVault(mobileOwner.owner_commitment, account.account_commitment, {
      proof: connectionProof({
        verified_at: "2026-08-30T12:16:00.000Z",
        expires_at: "2026-08-30T12:30:00.000Z",
      }),
    });
    const resumed = await controlAutonomousAutopilotSessionFromBody(
      created.session.autopilot_session_id,
      "resume",
      mobileOwner,
      new Date("2026-08-30T12:16:00.001Z"),
      WORKER_ENV,
      fetchImpl,
    );
    expect("session" in resumed && resumed.session?.status).toBe("running");
    const resumeRequest = requests.at(-1);
    expect(resumeRequest?.url).toBe(
      "https://worker.example/autopilot/sessions/worker_hyperliquid/resume",
    );
    expect(JSON.parse(resumeRequest?.body ?? "{}")).toMatchObject({
      venue_access: {
        hyperliquid: {
          status: "ready",
          network: "testnet",
          account_commitment: account.account_commitment,
        },
      },
    });
  });

  it("rejects a sealed vault whose recipient differs from the selected worker", async () => {
    const account = await storeAccount(mobileOwner.owner_commitment);
    await storeVault(mobileOwner.owner_commitment, account.account_commitment);
    const requests: Array<{ url: string; body: string }> = [];
    const created = await createAutonomousAutopilotSessionFromBody({
      session_policy: {
        venue_allowlist: ["hyperliquid"],
        market_allowlist: ["BTC-USD"],
      },
    }, mobileOwner, NOW, {
      ...WORKER_ENV,
      GHOLA_PRIVATE_AGENT_ENCLAVE_KEY_ID: "phala:cvm:different-worker",
    }, workerFetch(requests));

    expect(created.session.status).toBe("pending_worker");
    expect(created.session.execution_enabled).toBe(false);
    expect(requests).toEqual([]);
  });
});

async function storeAccount(ownerCommitment: string) {
  const account = createPrivateExecutionAccount({
    sessionId: ownerCommitment,
    turnkeyWalletId: `turnkey:${ownerCommitment}`,
    vaultSeed: `vault:${ownerCommitment}`,
    policySeed: "private-mode-default",
    platformSeed: `platforms:${ownerCommitment}`,
    vaultReady: false,
  });
  await putPrivateAccountRecord({
    version: 1,
    owner_commitment: ownerCommitment,
    account_commitment: account.account_commitment,
    session_commitment: account.session_commitment,
    turnkey_wallet_commitment: account.turnkey_wallet_commitment,
    vault_root_commitment: account.vault_root_commitment,
    note_root_commitment: gholaCommitment("note_root", account.vault_root_commitment),
    nullifier_root_commitment: gholaCommitment("nullifier_root", account.vault_root_commitment),
    platform_link_root: account.platform_link_root,
    policy_commitment: account.policy_commitment,
    privacy_mode: "private_mode",
    claim_boundary: "engine_gated_full_anonymity",
    vault_ready: false,
    account,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  return account;
}

async function storeVault(
  ownerCommitment: string,
  accountCommitment: string,
  options: {
    proof?: GholaHyperliquidConnectionProof | null;
    status?: GholaHyperliquidExecutionVault["status"];
    recordOwner?: string;
  } = {},
) {
  const created = createHyperliquidExecutionVault({
    account_commitment: accountCommitment,
    encrypted_execution_vault: {
      alg: "sealed-provider-v1",
      ciphertext: "stored-owner-ciphertext",
      recipient: "phala:cvm:test-worker",
      aad: `ghola/hyperliquid-execution-vault-v1|account:${accountCommitment}|network:testnet`,
    },
    now: new Date(CREATED_AT),
  });
  if (!created.ok) throw new Error(created.error);
  const status = options.status ?? "sealed";
  const vault: GholaHyperliquidExecutionVault = {
    ...created.vault,
    status,
    signer_binding: {
      version: 1,
      network: "testnet",
      owner_address: `0x${"1".repeat(40)}`,
      agent_address: `0x${"2".repeat(40)}`,
      binding_commitment: "binding_verified_test",
      verified_at: CREATED_AT,
    },
    connection_proof: options.proof === undefined ? connectionProof() : options.proof,
    updated_at: CREATED_AT,
  };
  await putHyperliquidExecutionVault({
    version: 1,
    owner_commitment: options.recordOwner ?? ownerCommitment,
    account_commitment: accountCommitment,
    vault_commitment: vault.vault_commitment,
    encrypted_vault_commitment: vault.encrypted_vault_commitment,
    recipient_commitment: vault.recipient_commitment,
    policy_commitment: vault.policy_commitment,
    status,
    vault,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  return vault;
}

async function storeAllocation(
  ownerCommitment: string,
  accountCommitment: string,
  proof: GholaHyperliquidConnectionProof | null = connectionProof(),
) {
  const allocation = createHyperliquidManagedAllocation({
    account_commitment: accountCommitment,
    execution_mode: "managed_testnet",
    now: new Date(CREATED_AT),
  });
  const stored = {
    ...allocation,
    connection_proof: proof,
    updated_at: CREATED_AT,
  };
  await putHyperliquidManagedAllocation({
    version: 1,
    owner_commitment: ownerCommitment,
    account_commitment: accountCommitment,
    allocation_commitment: stored.allocation_commitment,
    policy_commitment: stored.policy_commitment,
    pool_commitment: stored.pool_commitment,
    subledger_account_commitment: stored.subledger_account_commitment,
    status: "allocated",
    allocation: stored,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  return stored;
}

function connectionProof(
  overrides: Partial<GholaHyperliquidConnectionProof> = {},
): GholaHyperliquidConnectionProof {
  return {
    version: 1,
    status: "verified_no_funds",
    verification_commitment: "verification_verified_test",
    work_order_commitment: "work_order_verified_test",
    network: "testnet",
    credential_opened: true,
    signer_binding_verified: true,
    account_read_verified: true,
    order_request_built: true,
    verified_at: CREATED_AT,
    expires_at: "2026-08-30T12:15:00.000Z",
    ...overrides,
  };
}

function workerFetch(requests: Array<{ url: string; body: string }>): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, body });
    const payload = body ? JSON.parse(body) as Record<string, unknown> : {};
    const action = url.endsWith("/pause")
      ? "pause"
      : url.endsWith("/kill") ? "kill" : url.endsWith("/resume") ? "resume" : "create";
    return new Response(JSON.stringify({
      version: 1,
      session: {
        version: 2,
        autopilot_session_id: "worker_hyperliquid",
        worker_session_commitment: "worker_hyperliquid_commitment",
        status: action === "pause" ? "paused" : action === "kill" ? "killed" : "running",
        venue_access: action === "create" || action === "resume" ? payload.venue_access : {
          hyperliquid: {
            status: "ready",
            execution_mode: "byo_api_key",
            reason: "verified_hyperliquid_vault_ready",
          },
        },
        execution_enabled: action === "create" || action === "resume",
      },
      events: [],
    }), { status: action === "create" ? 201 : 200 });
  }) as typeof fetch;
}
