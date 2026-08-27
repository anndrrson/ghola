export function shouldResumeUnsignedTurnkeySetup(input: {
  usingTurnkeyOwner: boolean;
  authorizationProofCreated: boolean;
  error: unknown;
}): boolean {
  if (!input.usingTurnkeyOwner || input.authorizationProofCreated) return false;
  const message = input.error instanceof Error
    ? input.error.message
    : String(input.error || "");
  return /no active session found|requires a valid session/i.test(message);
}
