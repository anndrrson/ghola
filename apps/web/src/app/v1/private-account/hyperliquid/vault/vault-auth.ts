export type HyperliquidMainnetVaultAuthError =
  | "verified_email_required"
  | "step_up_authentication_required";

export function hyperliquidMainnetVaultAuthError(input: {
  testnetVault: boolean;
  emailVerified: boolean;
  mobileWalletProofVerified: boolean;
  consumerStepUpVerified: boolean;
}): HyperliquidMainnetVaultAuthError | null {
  if (input.testnetVault || input.mobileWalletProofVerified) return null;
  if (!input.emailVerified) return "verified_email_required";
  return input.consumerStepUpVerified ? null : "step_up_authentication_required";
}
