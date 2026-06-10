import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import {
  prepareAuctionCloseEpochTransaction,
  verifyAuctionPreparedTransaction,
} from "./private-account-auction-onchain";
import {
  signAndSendPreparedAuctionTransaction,
} from "./private-account-auction-submit";

const PROGRAM_ID = "5bmCDeaQceBpWgK8aADB4Tz4JzqZ9hkCi3qedC6oZR8A";
const MINT = "So11111111111111111111111111111111111111112";
const SIGNER = "11111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111";

function hex(byte: string, bytes = 32) {
  return byte.repeat(bytes);
}

function stubLegacyTransaction(input: {
  signer: Keypair;
  programId?: string;
}) {
  const programKey = input.programId ? { toBase58: () => input.programId } : input.signer.publicKey;
  return {
    signatures: [{ publicKey: input.signer.publicKey }],
    instructions: [{ programId: programKey }],
    partialSign: vi.fn(),
    serialize: vi.fn(() => new Uint8Array([1, 2, 3])),
  } as unknown as Transaction;
}

describe("private account auction on-chain transaction builder", () => {
  it("serializes close-auction counts in Anchor argument order", async () => {
    const serialize = vi.spyOn(Transaction.prototype, "serialize").mockImplementation(function serializeInstructionData(
      this: Transaction,
    ) {
      return Buffer.from(this.instructions[0].data);
    });
    try {
      const prepared = await prepareAuctionCloseEpochTransaction({
        signer_public_key: SIGNER,
        market_commitment_hex: hex("01"),
        epoch_id: 42,
        proof_a_hex: hex("02", 64),
        proof_b_hex: hex("03", 128),
        proof_c_hex: hex("04", 64),
        auction_order_root_hex: hex("05"),
        clearing_commitment_hex: hex("06"),
        clearing_price_commitment_hex: hex("07"),
        matched_root_hex: hex("08"),
        rolled_root_hex: hex("09"),
        matched_count: 12,
        rolled_count: 34,
        settlement_commitment_hex: hex("0a"),
        proof_commitment_hex: hex("0b"),
        client_reference: "close-count-order-test",
        env: {
          NODE_ENV: "unit",
          GHOLA_SHIELDED_POOL_PROGRAM_ID: PROGRAM_ID,
          GHOLA_SHIELDED_POOL_MINT: MINT,
          GHOLA_AUCTION_RECENT_BLOCKHASH: BLOCKHASH,
        },
      });
      const instructionData = Buffer.from(prepared.transaction_base64, "base64");
      const countOffset = 8 + 64 + 128 + 64 + (32 * 5);

      expect(instructionData.readUInt16LE(countOffset)).toBe(12);
      expect(instructionData.readUInt16LE(countOffset + 2)).toBe(34);
    } finally {
      serialize.mockRestore();
    }
  });

  it("accepts canonical BN254 fields above the old top-byte cutoff", async () => {
    const serialize = vi.spyOn(Transaction.prototype, "serialize").mockImplementation(function serializeInstructionData(
      this: Transaction,
    ) {
      return Buffer.from(this.instructions[0].data);
    });
    try {
      const prepared = await prepareAuctionCloseEpochTransaction({
        signer_public_key: SIGNER,
        market_commitment_hex: hex("01"),
        epoch_id: 42,
        proof_a_hex: hex("02", 64),
        proof_b_hex: hex("03", 128),
        proof_c_hex: hex("04", 64),
        auction_order_root_hex: `2f${"00".repeat(31)}`,
        clearing_commitment_hex: hex("06"),
        clearing_price_commitment_hex: hex("07"),
        matched_root_hex: hex("08"),
        rolled_root_hex: hex("09"),
        matched_count: 1,
        rolled_count: 0,
        settlement_commitment_hex: hex("0a"),
        proof_commitment_hex: hex("0b"),
        client_reference: "canonical-field-test",
        env: {
          NODE_ENV: "unit",
          GHOLA_SHIELDED_POOL_PROGRAM_ID: PROGRAM_ID,
          GHOLA_SHIELDED_POOL_MINT: MINT,
          GHOLA_AUCTION_RECENT_BLOCKHASH: BLOCKHASH,
        },
      });

      expect(prepared.operation).toBe("close_epoch");
    } finally {
      serialize.mockRestore();
    }
  });

  it("does not accept local-test confirmation mode outside test environments", async () => {
    const getTransaction = vi.spyOn(Connection.prototype, "getTransaction").mockResolvedValue(null as never);

    await expect(
      verifyAuctionPreparedTransaction({
        signature: "test_signature_must_not_be_locally_accepted",
        env: {
          NODE_ENV: "production",
          GHOLA_AUCTION_CONFIRMATION_MODE: "local_test",
          GHOLA_INSTITUTIONAL_FULL_PRODUCTION_ENABLED: "true",
          GHOLA_SHIELDED_POOL_PROGRAM_ID: PROGRAM_ID,
          GHOLA_SHIELDED_POOL_MINT: MINT,
          NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.devnet.solana.com",
        },
      }),
    ).rejects.toMatchObject({ code: "auction_transaction_not_finalized" });

    expect(getTransaction).toHaveBeenCalled();
    getTransaction.mockRestore();
  });

  it("signs and submits a prepared auction transaction with the required signer", async () => {
    const signer = Keypair.generate();
    const tx = stubLegacyTransaction({ signer });
    const from = vi.spyOn(Transaction, "from").mockReturnValue(tx);
    const transactionBase64 = Buffer.from([9]).toString("base64");
    const sendRawTransaction = vi
      .spyOn(Connection.prototype, "sendRawTransaction")
      .mockResolvedValue("submitted_signature" as never);
    const confirmTransaction = vi
      .spyOn(Connection.prototype, "confirmTransaction")
      .mockResolvedValue({
        context: { slot: 123 },
        value: { err: null },
      } as never);

    try {
      const submitted = await signAndSendPreparedAuctionTransaction({
        transactionBase64,
        signerKeypair: signer,
        rpcUrl: "http://127.0.0.1:8899",
        expectedProgramId: signer.publicKey.toBase58(),
        requiredSigners: [signer.publicKey.toBase58()],
      });

      expect(submitted.signature).toBe("submitted_signature");
      expect(submitted.signer_public_key).toBe(signer.publicKey.toBase58());
      expect(submitted.slot).toBe(123);
      expect(sendRawTransaction).toHaveBeenCalledOnce();
      expect(confirmTransaction).toHaveBeenCalledWith("submitted_signature", "finalized");
    } finally {
      from.mockRestore();
      sendRawTransaction.mockRestore();
      confirmTransaction.mockRestore();
    }
  });

  it("surfaces Solana logs when prepared auction transaction submission fails", async () => {
    const signer = Keypair.generate();
    const tx = stubLegacyTransaction({ signer });
    const from = vi.spyOn(Transaction, "from").mockReturnValue(tx);
    const transactionBase64 = Buffer.from([9]).toString("base64");
    const sendRawTransaction = vi
      .spyOn(Connection.prototype, "sendRawTransaction")
      .mockRejectedValue(Object.assign(new Error("simulation failed"), {
        logs: ["Program log: auction rejected"],
      }) as never);

    try {
      await expect(
        signAndSendPreparedAuctionTransaction({
          transactionBase64,
          signerKeypair: signer,
          rpcUrl: "http://127.0.0.1:8899",
          expectedProgramId: signer.publicKey.toBase58(),
          requiredSigners: [signer.publicKey.toBase58()],
        }),
      ).rejects.toMatchObject({
        code: "auction_transaction_send_failed",
        details: {
          message: "simulation failed",
          logs: ["Program log: auction rejected"],
        },
      });
    } finally {
      from.mockRestore();
      sendRawTransaction.mockRestore();
    }
  });

  it("surfaces confirmation rejection details for submitted auction transactions", async () => {
    const signer = Keypair.generate();
    const tx = stubLegacyTransaction({ signer });
    const from = vi.spyOn(Transaction, "from").mockReturnValue(tx);
    const transactionBase64 = Buffer.from([9]).toString("base64");
    const sendRawTransaction = vi
      .spyOn(Connection.prototype, "sendRawTransaction")
      .mockResolvedValue("rejected_signature" as never);
    const confirmTransaction = vi
      .spyOn(Connection.prototype, "confirmTransaction")
      .mockResolvedValue({
        context: { slot: 456 },
        value: { err: { InstructionError: [0, "Custom"] } },
      } as never);

    try {
      await expect(
        signAndSendPreparedAuctionTransaction({
          transactionBase64,
          signerKeypair: signer,
          rpcUrl: "http://127.0.0.1:8899",
          expectedProgramId: signer.publicKey.toBase58(),
          requiredSigners: [signer.publicKey.toBase58()],
        }),
      ).rejects.toMatchObject({
        code: "auction_transaction_confirmation_failed",
        details: {
          signature: "rejected_signature",
          slot: 456,
          err: { InstructionError: [0, "Custom"] },
        },
      });
    } finally {
      from.mockRestore();
      sendRawTransaction.mockRestore();
      confirmTransaction.mockRestore();
    }
  });

  it("rejects prepared auction transactions signed by the wrong local keypair", async () => {
    const signer = Keypair.generate();
    const wrongSigner = Keypair.generate();
    const from = vi.spyOn(Transaction, "from").mockReturnValue(stubLegacyTransaction({ signer }));
    const transactionBase64 = Buffer.from([9]).toString("base64");

    try {
      await expect(
        signAndSendPreparedAuctionTransaction({
          transactionBase64,
          signerKeypair: wrongSigner,
          expectedProgramId: signer.publicKey.toBase58(),
          requiredSigners: [signer.publicKey.toBase58()],
        }),
      ).rejects.toMatchObject({ code: "auction_required_signer_missing" });
    } finally {
      from.mockRestore();
    }
  });

  it("rejects prepared auction transactions for the wrong program", async () => {
    const signer = Keypair.generate();
    const from = vi.spyOn(Transaction, "from").mockReturnValue(stubLegacyTransaction({ signer }));
    const transactionBase64 = Buffer.from([9]).toString("base64");

    try {
      await expect(
        signAndSendPreparedAuctionTransaction({
          transactionBase64,
          signerKeypair: signer,
          expectedProgramId: Keypair.generate().publicKey.toBase58(),
          requiredSigners: [signer.publicKey.toBase58()],
        }),
      ).rejects.toMatchObject({ code: "auction_transaction_wrong_program" });
    } finally {
      from.mockRestore();
    }
  });
});
