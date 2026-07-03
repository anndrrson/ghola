import { NextRequest, NextResponse } from "next/server";
import { Turnkey } from "@turnkey/sdk-server";
import {
  fetchSessionUser,
  sameOrigin,
  SESSION_COOKIE_NAME,
} from "../../auth/session/_lib";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

function serverSigningEnabled() {
  return process.env.TURNKEY_SERVER_SIGNING_ENABLED === "true";
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

export async function POST(req: NextRequest) {
  try {
    const { message, messageHex, subOrgId, walletAddress } = await req.json();

    // Caller must provide exactly one of `message` (UTF-8 string) or
    // `messageHex` (already-binary payload). The hex path exists so
    // callers that need to sign cryptographic challenges (e.g. the
    // session-vault unlock challenge, which contains a binary salt)
    // can do so without the TextEncoder pass that would corrupt
    // non-UTF-8 bytes.
    const hasMessage = typeof message === "string";
    const hasMessageHex = typeof messageHex === "string";
    if (hasMessage === hasMessageHex) {
      return NextResponse.json(
        { error: "provide exactly one of `message` or `messageHex`" },
        { status: 400 }
      );
    }
    if (!subOrgId || !walletAddress) {
      return NextResponse.json(
        { error: "subOrgId and walletAddress are required" },
        { status: 400 }
      );
    }

    if (hasMessage && (message as string).length > 1024) {
      return NextResponse.json(
        { error: "message must be at most 1024 characters" },
        { status: 400 }
      );
    }
    if (hasMessageHex) {
      if ((messageHex as string).length > 4096) {
        return NextResponse.json(
          { error: "messageHex must be at most 4096 hex characters" },
          { status: 400 }
        );
      }
      if (!/^[0-9a-fA-F]*$/.test(messageHex as string) || (messageHex as string).length % 2 !== 0) {
        return NextResponse.json(
          { error: "messageHex must be even-length lowercase/uppercase hex" },
          { status: 400 }
        );
      }
    }
    if (typeof subOrgId !== "string" || subOrgId.length > 128) {
      return NextResponse.json(
        { error: "subOrgId must be a string with at most 128 characters" },
        { status: 400 }
      );
    }
    if (typeof walletAddress !== "string" || walletAddress.length > 128) {
      return NextResponse.json(
        { error: "walletAddress must be a string with at most 128 characters" },
        { status: 400 }
      );
    }

    if (!serverSigningEnabled()) {
      return NextResponse.json(
        {
          error: "Server-side Turnkey signing is disabled",
          code: "turnkey_server_signing_disabled",
          remediation:
            "Sign from a user-held Turnkey credential on the device. Do not route production auth or wallet signatures through Ghola's server.",
        },
        { status: 403 }
      );
    }

    // Defense-in-depth (only reachable once server signing is explicitly
    // enabled). Reject cross-site requests so a malicious page cannot
    // ride the user's session cookie to mint signatures (CSRF).
    if (!sameOrigin(req)) {
      return NextResponse.json(
        { error: "cross-site request rejected", code: "turnkey_cross_site_rejected" },
        { status: 403 }
      );
    }

    // Require a valid, server-verified session before signing anything.
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

    // Ownership binding (IDOR fix): the authenticated session must own
    // the requested sub-org. The binding is established at wallet
    // creation time by `create-wallet/route.ts` — every sub-org is
    // minted with `userEmail = <session email>`, and Turnkey indexes
    // sub-orgs by their root user's email. We re-derive the binding by
    // asking Turnkey for the set of sub-orgs registered under the
    // session email and asserting the requested `subOrgId` is in it.
    // Using Turnkey itself as the source of truth (rather than a
    // shadow `user_id → sub_org_id` table in thumper-cloud) avoids
    // drift: a sub-org cannot exist for an email without Turnkey
    // having recorded that email as the root user. The wallet address
    // is then re-validated against the sub-org's wallets so a caller
    // cannot ride one of their own sub-orgs to sign with another
    // sub-org's wallet.
    const sessionEmail = session.user.email?.trim().toLowerCase();
    if (!sessionEmail || !sessionEmail.includes("@")) {
      return NextResponse.json(
        {
          error: "session missing required identity binding",
          code: "turnkey_session_identity_missing",
        },
        { status: 403 }
      );
    }
    try {
      const owned = await client.getSubOrgIds({
        organizationId: orgId,
        filterType: "EMAIL",
        filterValue: sessionEmail,
      });
      const ownedIds = owned?.organizationIds ?? [];
      if (!ownedIds.includes(subOrgId)) {
        console.warn("Turnkey sign-message ownership check failed", {
          userId: session.user.id,
          requestedSubOrgId: subOrgId,
          ownedCount: ownedIds.length,
        });
        return NextResponse.json(
          {
            error: "wallet not owned by authenticated user",
            code: "turnkey_sub_org_not_owned",
          },
          { status: 403 }
        );
      }

      // Defense-in-depth: the requested wallet address must actually
      // belong to the sub-org (otherwise a caller could pair their own
      // sub-org with a third party's wallet address).
      const wallets = await client.getWallets({ organizationId: subOrgId });
      let walletMatches = false;
      for (const w of wallets?.wallets ?? []) {
        const accounts = await client.getWalletAccounts({
          organizationId: subOrgId,
          walletId: w.walletId,
        });
        if (accounts?.accounts?.some((a) => a.address === walletAddress)) {
          walletMatches = true;
          break;
        }
      }
      if (!walletMatches) {
        console.warn("Turnkey sign-message wallet/sub-org mismatch", {
          userId: session.user.id,
          subOrgId,
          walletAddress,
        });
        return NextResponse.json(
          {
            error: "wallet not owned by authenticated user",
            code: "turnkey_wallet_sub_org_mismatch",
          },
          { status: 403 }
        );
      }
    } catch (err) {
      const info = getTurnkeyErrorInfo(err);
      console.error("Turnkey sign-message ownership check error", info);
      return NextResponse.json(
        {
          error: "ownership verification failed",
          code: "turnkey_ownership_check_failed",
          turnkey: info,
        },
        { status: 500 }
      );
    }

    const hexPayload = hasMessageHex
      ? (messageHex as string).toLowerCase()
      : Buffer.from(new TextEncoder().encode(message as string)).toString("hex");

    // Sign using parent org credentials on behalf of sub-org
    const result = await client.signRawPayload({
      organizationId: subOrgId,
      signWith: walletAddress,
      payload: hexPayload,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
    });

    // Concatenate r + s into 64-byte Ed25519 signature
    const r = result.r;
    const s = result.s;
    if (!r || !s) {
      return NextResponse.json(
        { error: "Signing failed — no signature returned" },
        { status: 500 }
      );
    }

    const sigHex = r + s;
    const sigBase64 = Buffer.from(sigHex, "hex").toString("base64");

    return NextResponse.json({ signature: sigBase64 });
  } catch (err) {
    const info = getTurnkeyErrorInfo(err);
    console.error("Turnkey sign-message error", info);
    return NextResponse.json(
      {
        error: "Failed to sign message",
        code: "turnkey_sign_message_failed",
        turnkey: info,
      },
      { status: 500 }
    );
  }
}
