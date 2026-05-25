import { NextRequest, NextResponse } from "next/server";
import { Turnkey } from "@turnkey/sdk-server";
import {
  fetchSessionUser,
  sameOrigin,
  SESSION_COOKIE_NAME,
} from "../../auth/session/_lib";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

type TurnkeyApiClient = ReturnType<InstanceType<typeof Turnkey>["apiClient"]>;

function serverControlledWalletsEnabled() {
  if (process.env.TURNKEY_SERVER_CONTROLLED_WALLETS_ENABLED !== "true") {
    return false;
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.TURNKEY_DANGEROUS_SERVER_CONTROLLED_WALLETS_ALLOW_PRODUCTION !== "true"
  ) {
    return false;
  }
  return true;
}

function subOrgNameForEmail(email: string) {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `ghola-${slug || "user"}-${Date.now()}`;
}

function serverApiKey(apiPublicKey: string) {
  return {
    apiKeyName: "ghola-server",
    publicKey: apiPublicKey,
    curveType: "API_KEY_CURVE_P256" as const,
  };
}

function getErrorValue(err: unknown, key: string): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as Record<string, unknown>)[key];
}

function getTurnkeyErrorInfo(err: unknown) {
  const response = getErrorValue(err, "response");
  const responseRecord = response && typeof response === "object"
    ? response as Record<string, unknown>
    : {};
  const status = getErrorValue(err, "status")
    ?? getErrorValue(err, "statusCode")
    ?? responseRecord.status
    ?? responseRecord.statusCode;
  const code = getErrorValue(err, "code");
  const name = getErrorValue(err, "name");
  const message = getErrorValue(err, "message");

  return {
    name: typeof name === "string" ? name : "TurnkeyError",
    code: typeof code === "string" || typeof code === "number" ? String(code) : undefined,
    status: typeof status === "number" || typeof status === "string" ? status : undefined,
    message: typeof message === "string" ? message.slice(0, 500) : "Turnkey request failed",
  };
}

async function getUsableWallet(
  client: TurnkeyApiClient,
  subOrgId: string
) {
  const users = await client.getUsers({ organizationId: subOrgId });
  const hasApiKey = users.users?.some((user) => user.apiKeys?.length);
  if (!hasApiKey) return null;

  const wallets = await client.getWallets({
    organizationId: subOrgId,
  });
  if (!wallets?.wallets?.length) return null;

  const wallet = wallets.wallets[0];
  const accounts = await client.getWalletAccounts({
    organizationId: subOrgId,
    walletId: wallet.walletId,
  });
  const solanaAccount = accounts?.accounts?.find(
    (a: { addressFormat?: string }) =>
      a.addressFormat === "ADDRESS_FORMAT_SOLANA"
  );
  if (!solanaAccount) return null;

  return {
    subOrgId,
    walletAddress: solanaAccount.address,
    walletId: wallet.walletId,
  };
}

export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    const normalizedEmail = typeof email === "string"
      ? email.trim().toLowerCase()
      : "";
    if (!normalizedEmail || !normalizedEmail.includes("@") || normalizedEmail.length > 254) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    if (!serverControlledWalletsEnabled()) {
      return NextResponse.json(
        {
          error: "Server-controlled Turnkey wallet creation is disabled",
          code: "turnkey_server_controlled_wallets_disabled",
          remediation:
            "Use Turnkey Swift SDK/Auth Proxy so wallet credentials are created and held by the user's device.",
        },
        { status: 403 }
      );
    }

    // Defense-in-depth (only reachable once server-controlled wallets are
    // explicitly enabled). Reject cross-site requests so a malicious page
    // cannot ride the user's session cookie to create/enumerate wallets
    // (CSRF).
    if (!sameOrigin(req)) {
      return NextResponse.json(
        { error: "cross-site request rejected", code: "turnkey_cross_site_rejected" },
        { status: 403 }
      );
    }

    // Require a valid, server-verified session.
    const sessionToken = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!sessionToken) {
      return NextResponse.json(
        { error: "authentication required", code: "turnkey_auth_required" },
        { status: 401 }
      );
    }
    const session = await fetchSessionUser(sessionToken).catch(() => null);
    if (!session || !session.ok) {
      return NextResponse.json(
        { error: "authentication required", code: "turnkey_auth_required" },
        { status: 401 }
      );
    }

    // Ownership assertion: a user may only create/retrieve the wallet for
    // THEIR OWN email. The sub-org is derived from the email (the Turnkey
    // lookup below filters by EMAIL), so binding the requested email to
    // the authenticated session email prevents a signed-in user from
    // provisioning or fetching a wallet under someone else's identity
    // (IDOR). Compared case-insensitively to match the normalization
    // applied to both values.
    if (normalizedEmail !== session.user.email.trim().toLowerCase()) {
      return NextResponse.json(
        {
          error: "email does not match the authenticated session",
          code: "turnkey_email_session_mismatch",
        },
        { status: 403 }
      );
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
      filterValue: normalizedEmail,
    });

    if (existing?.organizationIds?.length) {
      // Old sub-orgs may not contain the server API key, which makes
      // signing fail with ORGANIZATION_MISMATCH. Reuse only usable ones.
      for (const subOrgId of existing.organizationIds) {
        const wallet = await getUsableWallet(client, subOrgId);
        if (wallet) return NextResponse.json(wallet);
      }
    }

    // Create new sub-org with Solana wallet
    const result = await client.createSubOrganization({
      organizationId: orgId,
      subOrganizationName: subOrgNameForEmail(normalizedEmail),
      rootQuorumThreshold: 1,
      rootUsers: [
        {
          userName: normalizedEmail,
          userEmail: normalizedEmail,
          apiKeys: [serverApiKey(apiPublicKey)],
          authenticators: [],
          oauthProviders: [],
        },
      ],
      wallet: {
        walletName: "ghola Wallet",
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
      console.error("Turnkey create-wallet missing expected result fields", {
        hasSubOrgId: Boolean(subOrgId),
        hasWalletId: Boolean(walletId),
        hasWalletAddress: Boolean(walletAddress),
      });
      return NextResponse.json(
        {
          error: "Failed to create wallet",
          code: "turnkey_create_wallet_incomplete_result",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ subOrgId, walletAddress, walletId });
  } catch (err) {
    const info = getTurnkeyErrorInfo(err);
    console.error("Turnkey create-wallet error", info);
    return NextResponse.json(
      {
        error: "Failed to create wallet",
        code: "turnkey_create_wallet_failed",
        turnkey: info,
      },
      { status: 500 }
    );
  }
}
