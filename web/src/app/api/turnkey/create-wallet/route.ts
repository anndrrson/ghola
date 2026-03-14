import { NextRequest, NextResponse } from "next/server";
import { Turnkey } from "@turnkey/sdk-server";
import { ApiKeyStamper } from "@turnkey/api-key-stamper";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const orgId = process.env.TURNKEY_ORG_ID;
    const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
    const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
    if (!orgId || !apiPublicKey || !apiPrivateKey) {
      return NextResponse.json(
        { error: "Turnkey not configured" },
        { status: 500 }
      );
    }

    const sdk = new Turnkey({
      apiBaseUrl: TURNKEY_API_BASE_URL,
      apiPublicKey,
      apiPrivateKey,
      defaultOrganizationId: orgId,
    });

    const client = sdk.apiClient();

    // Check if sub-org already exists for this email
    const existing = await client.getSubOrgIds({
      organizationId: orgId,
      filterType: "EMAIL",
      filterValue: email,
    });

    if (existing?.organizationIds?.length) {
      // Sub-org exists — get its wallets
      const subOrgId = existing.organizationIds[0];
      const wallets = await client.getWallets({
        organizationId: subOrgId,
      });
      if (wallets?.wallets?.length) {
        const wallet = wallets.wallets[0];
        const accounts = await client.getWalletAccounts({
          organizationId: subOrgId,
          walletId: wallet.walletId,
        });
        const solanaAccount = accounts?.accounts?.find(
          (a: { addressFormat?: string }) =>
            a.addressFormat === "ADDRESS_FORMAT_SOLANA"
        );
        if (solanaAccount) {
          return NextResponse.json({
            subOrgId,
            walletAddress: solanaAccount.address,
            walletId: wallet.walletId,
          });
        }
      }
    }

    // Create new sub-org with Solana wallet
    const result = await client.createSubOrganization({
      subOrganizationName: `ghola-${email}-${Date.now()}`,
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: email,
          userEmail: email,
          apiKeys: [],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      wallet: {
        walletName: "Ghola Wallet",
        accounts: [
          {
            curve: "CURVE_ED25519",
            pathFormat: "PATH_FORMAT_BIP32",
            path: "m/44'/501'/0'/0'",
            addressFormat: "ADDRESS_FORMAT_SOLANA",
          },
        ],
      },
    });

    const subOrgId = result.subOrganizationId;
    const walletId = result.wallet?.walletId;
    const walletAddress = result.wallet?.addresses?.[0];

    if (!subOrgId || !walletId || !walletAddress) {
      return NextResponse.json(
        { error: "Failed to create wallet" },
        { status: 500 }
      );
    }

    return NextResponse.json({ subOrgId, walletAddress, walletId });
  } catch (err) {
    console.error("Turnkey create-wallet error:", err);
    return NextResponse.json(
      { error: "Failed to create wallet" },
      { status: 500 }
    );
  }
}
