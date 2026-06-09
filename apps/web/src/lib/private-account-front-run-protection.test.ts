import { describe, expect, it } from "vitest";
import {
  buildFrontRunCertificate,
  deriveFrontRunProtection,
  zeroFrontRunBlocker,
} from "./private-account-front-run-protection";

describe("private account front-run protection", () => {
  it("does not call current scoped venue access zero-front-run", () => {
    const protection = deriveFrontRunProtection({
      accessMode: "byo_api_key",
      noPublicMempool: true,
    });

    expect(protection).toMatchObject({
      kind: "pre_submit_private",
      label: "Pre-submit private",
      zeroFrontRun: false,
      canLiveSubmitInZeroMode: false,
    });
    expect(protection.reasonCodes).toContain("venue_can_observe_submitted_order");
    expect(zeroFrontRunBlocker(protection)).toContain("encrypted fair ordering");
  });

  it("certifies zero-front-run only when matching is private and fair", () => {
    const protection = deriveFrontRunProtection({
      accessMode: "sealed_batch_auction",
      encryptedUntilMatch: true,
      fairOrderingCertificate: true,
      noPublicMempool: true,
      uniformBatchAuction: true,
    });

    expect(protection).toMatchObject({
      kind: "zero_certified",
      label: "Zero-front-run certified",
      zeroFrontRun: true,
      canLiveSubmitInZeroMode: true,
      reasonCodes: [],
    });
    expect(zeroFrontRunBlocker(protection)).toBeNull();
  });

  it("keeps sealed batch pending until a certificate commitment exists", () => {
    const protection = deriveFrontRunProtection({
      accessMode: "sealed_batch_auction",
      encryptedUntilMatch: true,
      noPublicMempool: true,
      uniformBatchAuction: true,
    });

    expect(protection).toMatchObject({
      kind: "blocked",
      label: "Zero-front-run pending",
      zeroFrontRun: false,
      canLiveSubmitInZeroMode: false,
      certificateCommitment: null,
      reasonCodes: ["front_run_certificate_missing"],
    });
  });

  it("builds a receipt-bindable zero-front-run certificate from clearing proof evidence", () => {
    const certificate = buildFrontRunCertificate({
      accessMode: "sealed_batch_auction",
      auctionEpochCommitment: "auction_epoch_test",
      auctionOrderCommitment: "auction_order_test",
      clearingCommitment: "clearing_test",
      proofCommitment: "proof_test",
      finalityCommitment: "finality_test",
      runtimeAttestationCommitment: "runtime_attestation_test",
    });

    expect(certificate).toMatchObject({
      version: 1,
      access_mode: "sealed_batch_auction",
      encrypted_until_match: true,
      no_public_mempool: true,
      fair_ordering: "uniform_batch_auction",
      auction_epoch_commitment: "auction_epoch_test",
      auction_order_commitment: "auction_order_test",
      clearing_commitment: "clearing_test",
      proof_commitment: "proof_test",
      finality_commitment: "finality_test",
      runtime_attestation_commitment: "runtime_attestation_test",
      reason_codes: [],
    });
    expect(certificate?.certificate_commitment).toMatch(/^front_run_certificate_[0-9a-f]{48}$/);

    const protection = deriveFrontRunProtection({
      accessMode: "sealed_batch_auction",
      frontRunCertificateCommitment: certificate?.certificate_commitment,
    });
    expect(protection).toMatchObject({
      kind: "zero_certified",
      zeroFrontRun: true,
      canLiveSubmitInZeroMode: true,
      certificateCommitment: certificate?.certificate_commitment,
    });
  });

  it("blocks public pending-order routes from zero-front-run mode", () => {
    const protection = deriveFrontRunProtection({
      accessMode: "byo_api_key",
      publicMempool: true,
    });

    expect(protection).toMatchObject({
      kind: "blocked",
      zeroFrontRun: false,
      canLiveSubmitInZeroMode: false,
    });
    expect(protection.reasonCodes).toEqual(["public_mempool_visible"]);
  });
});
