import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function associatedTokenAddress(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function createAssociatedTokenAccountIdempotent(input: {
  payer: PublicKey;
  address: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([1]),
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.address, isSigner: false, isWritable: true },
      { pubkey: input.owner, isSigner: false, isWritable: false },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

export function createTransferChecked(input: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  amount: bigint;
  decimals: number;
}) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(input.amount, 1);
  data[9] = input.decimals;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    data,
    keys: [
      { pubkey: input.source, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.destination, isSigner: false, isWritable: true },
      { pubkey: input.authority, isSigner: true, isWritable: false },
    ],
  });
}
