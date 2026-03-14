import { NextRequest, NextResponse } from "next/server";
import { Turnkey } from "@turnkey/sdk-server";

const TURNKEY_API_BASE_URL = "https://api.turnkey.com";

export async function POST(req: NextRequest) {
  try {
    const { message, subOrgId, walletAddress } = await req.json();
    if (!message || !subOrgId || !walletAddress) {
      return NextResponse.json(
        { error: "message, subOrgId, and walletAddress are required" },
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

    // Convert message string to hex
    const messageBytes = new TextEncoder().encode(message);
    const hexPayload = Buffer.from(messageBytes).toString("hex");

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
    console.error("Turnkey sign-message error:", err);
    return NextResponse.json(
      { error: "Failed to sign message" },
      { status: 500 }
    );
  }
}
