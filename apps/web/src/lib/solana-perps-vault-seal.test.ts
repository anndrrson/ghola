import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import {
  parseSolanaPerpsCredentialImport,
  validateSolanaPerpsExecutionCredentialDraft,
} from "./solana-perps-vault-seal";

describe("Solana perps credential import", () => {
  function expectValidImport(value: string) {
    const imported = parseSolanaPerpsCredentialImport(value);
    expect(imported.fields).toContain("authority_private_key");
    expect(imported.fields).toContain("authority");
    expect(validateSolanaPerpsExecutionCredentialDraft(imported.draft)).toEqual([]);
    return imported.draft;
  }

  it("accepts a raw base58 authority private key", () => {
    const keypair = Keypair.generate();
    const secret = bs58.encode(keypair.secretKey);
    const draft = expectValidImport(secret);
    expect(draft.authority).toBe(keypair.publicKey.toBase58());
  });

  it("accepts a raw Solana keypair JSON array", () => {
    const keypair = Keypair.generate();
    const draft = expectValidImport(JSON.stringify(Array.from(keypair.secretKey)));
    expect(draft.authority).toBe(keypair.publicKey.toBase58());
  });

  it("accepts a JSON object with a string private key", () => {
    const keypair = Keypair.generate();
    const draft = expectValidImport(JSON.stringify({
      authority_private_key: bs58.encode(keypair.secretKey),
    }));
    expect(draft.authority).toBe(keypair.publicKey.toBase58());
  });

  it("accepts a JSON object with an array private key", () => {
    const keypair = Keypair.generate();
    const draft = expectValidImport(JSON.stringify({
      authority_private_key: Array.from(keypair.secretKey),
    }));
    expect(draft.authority).toBe(keypair.publicKey.toBase58());
  });

  it("accepts KEY=VALUE lines", () => {
    const keypair = Keypair.generate();
    const draft = expectValidImport([
      `authority_private_key=${bs58.encode(keypair.secretKey)}`,
      "trader_pda_index=1",
      "trader_subaccount_index=2",
    ].join("\n"));
    expect(draft.authority).toBe(keypair.publicKey.toBase58());
    expect(draft.trader_pda_index).toBe("1");
    expect(draft.trader_subaccount_index).toBe("2");
  });
});
