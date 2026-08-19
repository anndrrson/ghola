import {
  bindPrivateMobileWallet,
  getPrivateMobileWalletBindingChallenge,
} from "./private-account-client";
import {
  connectSolanaWallet,
  privateAccountMobileProofHeaders,
  requiredSolanaProvider,
  walletSignBytes,
} from "./wallet-request-proof";

export async function authorizePrivateAccountWalletRequest(input: {
  path: string;
  body: unknown;
}): Promise<Record<string, string>> {
  const wallet = await connectSolanaWallet();
  const provider = requiredSolanaProvider();
  const challenge = await getPrivateMobileWalletBindingChallenge(wallet);
  const signature = await walletSignBytes(
    provider,
    new TextEncoder().encode(challenge.message),
    wallet,
  );
  await bindPrivateMobileWallet({
    wallet_pubkey: wallet,
    message: challenge.message,
    signature_b64: bytesToBase64(signature),
  });
  return privateAccountMobileProofHeaders({
    path: input.path,
    body: input.body,
    wallet,
    signBytes: async (bytes) => walletSignBytes(provider, bytes, wallet),
  });
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
