import { NextRequest, NextResponse } from "next/server";
import { Turnkey } from "@turnkey/sdk-server";
import { logger } from "@/lib/logger";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

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
    logger.error("Turnkey sign-message error:", err);
    return NextResponse.json(
      { error: "Failed to sign message" },
      { status: 500 }
    );
  }
}
