import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { POST as submitPublicPhoenixRoute } from "@/app/v1/private-account/public-live/phoenix/submit/route";
import {
  buildPublicLivePhoenixChallenge,
  submitPublicLivePhoenixOrder,
  verifyPublicLiveWalletProof,
} from "./private-account-public-live";

describe("public private-account live Phoenix access", () => {
  afterEach(() => {
    delete process.env.VERCEL_ENV;
    delete process.env.GHOLA_PUBLIC_LIVE_PHOENIX_REVENUE_GUARD_MODE;
    delete process.env.GHOLA_PUBLIC_LIVE_PHOENIX_ALLOW_UNPAID;
  });

  it("verifies a wallet-signed public live challenge and rejects nonce replay", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const wallet = bs58.encode(ed25519.getPublicKey(secret));
    const challenge = buildPublicLivePhoenixChallenge({
      wallet_pubkey: wallet,
      now: new Date("2026-06-13T12:00:00.000Z"),
      nonce: "nonce-public-live-1",
    });
    expect("error" in challenge).toBe(false);
    if ("error" in challenge) return;

    const signature = ed25519.sign(new TextEncoder().encode(challenge.message), secret);
    const body = {
      wallet_pubkey: wallet,
      message: challenge.message,
      signature_b64: Buffer.from(signature).toString("base64"),
    };
    const first = verifyPublicLiveWalletProof(body, {
      nowMs: new Date("2026-06-13T12:00:30.000Z").getTime(),
    });
    expect(first.ok).toBe(true);
    expect(first.ok && first.proof.owner_commitment).toMatch(/^public_live_owner_/);

    const replay = verifyPublicLiveWalletProof(body, {
      nowMs: new Date("2026-06-13T12:00:31.000Z").getTime(),
    });
    expect(replay).toMatchObject({
      ok: false,
      error: "public_live_wallet_proof_replayed",
    });
  });

  it("submits only a sealed Phoenix pooled order payload to the worker", async () => {
    const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl = async (input: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        init,
        body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        status: "submitted",
        result_commitment: "solana_perps_result_abc",
        provider_ref_commitment: "solana_perps_provider_ref_abc",
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await submitPublicLivePhoenixOrder({
      env: {
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      },
      fetchImpl: fetchImpl as typeof fetch,
      allocation_commitment: "pooled_venue_allocation_abc",
      policy_commitment: "public_live_policy_abc",
      body: {
        ack_live_order: true,
        work_order_commitment: "public_live_phoenix_work_order_abc",
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "ciphertext-ciphertext-ciphertext",
          recipient: "phala:cvm:test",
          aad: "ghola/private-execution-instruction-v1|work_order:public_live_phoenix_work_order_abc|venue:phoenix|recipient:phala:cvm:test",
        },
      },
    });

    expect("error" in result).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://worker.example/venues/solana-perps/orders");
    expect(calls[0].init?.headers).toMatchObject({
      "x-ghola-sealed-execution-required": "true",
    });
    expect(calls[0].body).toMatchObject({
      platform_class: "solana_perps_market",
      venue_id: "phoenix",
      execution_mode: "ghola_pooled",
      allocation_commitment: "pooled_venue_allocation_abc",
      operation_class: "perp_limit_order",
    });
    expect(JSON.stringify(calls[0].body)).not.toContain("private_key");
    expect(JSON.stringify(calls[0].body)).not.toContain("strategy_note");
  });

  it("blocks public Phoenix live submit in production without a paid private-agent context", async () => {
    const calls: Array<unknown> = [];
    const result = await submitPublicLivePhoenixOrder({
      env: {
        VERCEL_ENV: "production",
        GHOLA_PRIVATE_AGENT_EXECUTION_URL: "https://worker.example",
        GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN: "worker-token",
      },
      fetchImpl: (async (...args: unknown[]) => {
        calls.push(args);
        return new Response("{}", { status: 202 });
      }) as typeof fetch,
      allocation_commitment: "pooled_venue_allocation_abc",
      policy_commitment: "public_live_policy_abc",
      body: {
        ack_live_order: true,
        work_order_commitment: "public_live_phoenix_work_order_abc",
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "ciphertext-ciphertext-ciphertext",
          recipient: "phala:cvm:test",
          aad: "ghola/private-execution-instruction-v1|work_order:public_live_phoenix_work_order_abc|venue:phoenix|recipient:phala:cvm:test",
        },
      },
    });

    expect(result).toMatchObject({
      error: "private_agent_subscription_required",
      entitlement_required: "paid_private_agent_plan",
      status: 402,
    });
    expect(calls).toHaveLength(0);
  });

  it("blocks the production public Phoenix route before pooled allocation preparation", async () => {
    process.env.VERCEL_ENV = "production";
    const secret = ed25519.utils.randomPrivateKey();
    const wallet = bs58.encode(ed25519.getPublicKey(secret));
    const challenge = buildPublicLivePhoenixChallenge({
      wallet_pubkey: wallet,
      now: new Date(),
      nonce: `route-revenue-${Date.now()}`,
    });
    expect("error" in challenge).toBe(false);
    if ("error" in challenge) return;
    const signature = ed25519.sign(new TextEncoder().encode(challenge.message), secret);
    const workOrderCommitment = "public_live_phoenix_work_order_revenue_route";

    const res = await submitPublicPhoenixRoute(new Request("https://ghola.test/v1/private-account/public-live/phoenix/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet_pubkey: wallet,
        message: challenge.message,
        signature_b64: Buffer.from(signature).toString("base64"),
        accepted_terms: true,
        accepted_risk: true,
        not_prohibited_person: true,
        ack_live_order: true,
        work_order_commitment: workOrderCommitment,
        encrypted_execution_instruction_bundle: {
          alg: "sealed-provider-v1",
          ciphertext: "ciphertext-ciphertext-ciphertext",
          recipient: "phala:cvm:test",
          aad: `ghola/private-execution-instruction-v1|work_order:${workOrderCommitment}|venue:phoenix|recipient:phala:cvm:test`,
        },
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body).toMatchObject({
      error: "private_agent_subscription_required",
      entitlement_required: "paid_private_agent_plan",
    });
  });
});
