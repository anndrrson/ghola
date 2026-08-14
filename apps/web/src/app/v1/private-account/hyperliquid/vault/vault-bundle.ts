export function isTestnetVaultBundle(body: unknown) {
  if (!body || typeof body !== "object") return false;
  const encrypted = (body as Record<string, unknown>).encrypted_execution_vault;
  if (!encrypted || typeof encrypted !== "object") return false;
  const aad = (encrypted as Record<string, unknown>).aad;
  return typeof aad === "string" &&
    aad.startsWith("ghola/hyperliquid-execution-vault-v1|") &&
    aad.endsWith("|network:testnet");
}
