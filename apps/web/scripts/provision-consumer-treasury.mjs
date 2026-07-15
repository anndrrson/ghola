import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";

const API_BASE_URL = "https://api.turnkey.com";
const TREASURY_IDENTITY = "consumer-treasury@ghola.xyz";
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const organizationId = required("TURNKEY_ORG_ID");
const apiPublicKey = required("TURNKEY_API_PUBLIC_KEY");
const apiPrivateKey = required("TURNKEY_API_PRIVATE_KEY");
const sdk = new Turnkey({
  apiBaseUrl: API_BASE_URL,
  apiPublicKey,
  apiPrivateKey,
  defaultOrganizationId: organizationId,
});
const client = sdk.apiClient();

let treasury = await findTreasury();
if (!treasury) {
  const created = await client.createSubOrganization({
    organizationId,
    subOrganizationName: "ghola-consumer-treasury",
    rootQuorumThreshold: 1,
    rootUsers: [{
      userName: "ghola-consumer-treasury-service",
      userEmail: TREASURY_IDENTITY,
      apiKeys: [{ apiKeyName: "ghola-consumer-treasury-server", publicKey: apiPublicKey, curveType: "API_KEY_CURVE_P256" }],
      authenticators: [],
      oauthProviders: [],
    }],
    wallet: {
      walletName: "ghola-consumer-usdc-treasury",
      accounts: [{
        curve: "CURVE_ED25519",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/501'/0'/0'",
        addressFormat: "ADDRESS_FORMAT_SOLANA",
      }],
    },
  });
  treasury = {
    subOrganizationId: created.subOrganizationId,
    walletId: created.wallet?.walletId,
    address: created.wallet?.addresses?.[0],
  };
}
if (!treasury.subOrganizationId || !treasury.walletId || !treasury.address) throw new Error("treasury provisioning returned incomplete identifiers");

const unsigned = new Transaction({
  feePayer: new PublicKey(treasury.address),
  recentBlockhash: Keypair.generate().publicKey.toBase58(),
}).add(new TransactionInstruction({
  programId: MEMO_PROGRAM_ID,
  data: Buffer.from("ghola-consumer-treasury-signing-canary-v1"),
  keys: [],
}));
const signer = new TurnkeySigner({ organizationId: treasury.subOrganizationId, client });
const signed = await signer.signTransaction(unsigned, treasury.address, treasury.subOrganizationId);
if (!signed.verifySignatures()) throw new Error("treasury signing canary failed");

console.log(JSON.stringify({
  version: 1,
  organization_id: treasury.subOrganizationId,
  wallet_id: treasury.walletId,
  treasury_address: treasury.address,
  signing_canary: "passed_unbroadcast",
}, null, 2));

async function findTreasury() {
  const suborgs = await client.getSubOrgIds({ organizationId, filterType: "EMAIL", filterValue: TREASURY_IDENTITY });
  for (const subOrganizationId of suborgs.organizationIds ?? []) {
    const wallets = await client.getWallets({ organizationId: subOrganizationId });
    for (const wallet of wallets.wallets ?? []) {
      if (wallet.walletName !== "ghola-consumer-usdc-treasury") continue;
      const accounts = await client.getWalletAccounts({ organizationId: subOrganizationId, walletId: wallet.walletId });
      const account = accounts.accounts?.find((item) => item.addressFormat === "ADDRESS_FORMAT_SOLANA");
      if (account) return { subOrganizationId, walletId: wallet.walletId, address: account.address };
    }
  }
  return null;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
