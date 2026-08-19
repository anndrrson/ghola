const ERROR_CODE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/u;

const VERIFIED_EMAIL_CODES = new Set([
  "verified_email_required",
  "investor_email_verification_required",
  "email_verification_required",
]);

const EMAIL_MISMATCH_CODES = new Set([
  "investor_access_email_mismatch",
  "access_pass_email_mismatch",
  "investor_invite_email_mismatch",
]);

const SUBSCRIPTION_CODES = new Set([
  "private_agent_subscription_required",
  "subscription_required",
  "investor_invite_required",
]);

export function investorFacingErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error
    ? error.message.trim()
    : typeof error === "string" ? error.trim() : "";
  const normalized = message.toLowerCase();

  if (VERIFIED_EMAIL_CODES.has(normalized)) {
    return "Verify the invited email account, then recheck access.";
  }
  if (EMAIL_MISMATCH_CODES.has(normalized) || /(?:pass|invite).{0,30}email.{0,30}(?:mismatch|does not match)/u.test(normalized)) {
    return "This investor pass belongs to a different email. Sign out and use the exact invited account.";
  }
  if (SUBSCRIPTION_CODES.has(normalized) || /(?:private[- ]agent|investor).{0,20}subscription required/u.test(normalized)) {
    return "Investor access is not active. Reopen the original invitation link or review your plan.";
  }
  if (normalized === "access pass has expired" || normalized === "investor_access_expired") {
    return "This investor pass has expired. Ask the sender for a new invitation.";
  }

  return message && !ERROR_CODE.test(normalized) ? message : fallback;
}
