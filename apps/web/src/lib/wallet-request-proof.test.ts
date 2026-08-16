import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { verifyPrivateAccountMobileProof } from "./private-account-mobile-proof";
import { privateAccountMobileProofHeaders } from "./wallet-request-proof";

describe("privateAccountMobileProofHeaders", () => {
  it("creates an exact body-bound proof accepted by the server verifier", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const wallet = bs58.encode(ed25519.getPublicKey(secret));
    const body = { encrypted_execution_vault: { version: 1, network: "mainnet" } };
    const nowMs = 1_782_000_000_000;
    const headers = await privateAccountMobileProofHeaders({
      path: "/v1/private-account/hyperliquid/vault",
      body,
      wallet,
      nowMs,
      nonce: "vault-proof-0001",
      signBytes: async (bytes) => ed25519.sign(bytes, secret),
    });
    const request = new Request("https://ghola.test/v1/private-account/hyperliquid/vault", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    expect(verifyPrivateAccountMobileProof({
      req: request,
      body,
      maxSkewMs: 60_000,
      nowMs,
    })).toMatchObject({ ok: true, wallet, nonce: "vault-proof-0001", timestampMs: nowMs });
    expect(verifyPrivateAccountMobileProof({
      req: request,
      body: { encrypted_execution_vault: { version: 1, network: "testnet" } },
      maxSkewMs: 60_000,
      nowMs,
    })).toEqual({ ok: false, error: "mobile_proof_invalid", status: 403 });
  });

  it("rejects an invalid proof path before signing", async () => {
    await expect(privateAccountMobileProofHeaders({
      path: "https://evil.example/vault",
      body: {},
      wallet: "wallet",
      nonce: "vault-proof-0002",
      signBytes: async () => new Uint8Array(64),
    })).rejects.toThrow("proof path is invalid");
  });

  it("binds a DELETE proof to its method and empty JSON body", async () => {
    const secret = ed25519.utils.randomPrivateKey();
    const wallet = bs58.encode(ed25519.getPublicKey(secret));
    const body = {};
    const nowMs = 1_782_000_000_000;
    const headers = await privateAccountMobileProofHeaders({
      method: "DELETE",
      path: "/v1/private-account/hyperliquid/vault",
      body,
      wallet,
      nowMs,
      nonce: "vault-delete-proof-0001",
      signBytes: async (bytes) => ed25519.sign(bytes, secret),
    });
    const request = new Request("https://ghola.test/v1/private-account/hyperliquid/vault", {
      method: "DELETE",
      headers,
      body: JSON.stringify(body),
    });

    expect(verifyPrivateAccountMobileProof({
      req: request,
      body,
      maxSkewMs: 60_000,
      nowMs,
    })).toMatchObject({ ok: true, wallet, nonce: "vault-delete-proof-0001", timestampMs: nowMs });
    expect(verifyPrivateAccountMobileProof({
      req: new Request("https://ghola.test/v1/private-account/hyperliquid/vault", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      body,
      maxSkewMs: 60_000,
      nowMs,
    })).toEqual({ ok: false, error: "mobile_proof_invalid", status: 403 });
  });
});
