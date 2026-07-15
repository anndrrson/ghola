// @vitest-environment node
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  createTransferChecked,
} from "./solana-usdc-instructions";

describe("consumer Solana USDC instructions", () => {
  it("builds the canonical idempotent associated-token instruction", () => {
    const payer = new PublicKey("FDp6krm71TRZnmMKFnZH8gpypC4FtEAeBgcpVkz44sdZ");
    const owner = new PublicKey("11111111111111111111111111111111");
    const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const address = associatedTokenAddress(mint, owner);
    const instruction = createAssociatedTokenAccountIdempotent({ payer, address, owner, mint });
    expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(Array.from(instruction.data)).toEqual([1]);
    expect(instruction.keys.map((key) => key.pubkey.toBase58())).toEqual([
      payer.toBase58(),
      address.toBase58(),
      owner.toBase58(),
      mint.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
  });

  it("encodes TransferChecked with an exact u64 amount and six decimals", () => {
    const source = Keypair.generate().publicKey;
    const destination = Keypair.generate().publicKey;
    const authority = Keypair.generate().publicKey;
    const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const instruction = createTransferChecked({ source, mint, destination, authority, amount: BigInt("12345678"), decimals: 6 });
    expect(instruction.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(instruction.data[0]).toBe(12);
    expect(instruction.data.readBigUInt64LE(1)).toBe(BigInt("12345678"));
    expect(instruction.data[9]).toBe(6);
    expect(instruction.keys[3]).toMatchObject({ isSigner: true, isWritable: false });
  });
});
