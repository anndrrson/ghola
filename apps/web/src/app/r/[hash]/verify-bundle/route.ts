/**
 * GET /r/[hash]/verify-bundle
 *
 * Server-side companion to the chat-side "Download verification
 * bundle" button. A user who has only a receipt hash in hand (e.g.
 * shared via URL) can fetch the zip without ever opening the chat
 * UI. That makes the verification chain self-serve for journalists,
 * regulators, and auditors who never used ghola interactively.
 *
 * KEY DISTINCTION VS. THE CLIENT-SIDE BUNDLE:
 *   - The browser modal's bundle includes the live local
 *     `IntegrityVerificationResult` — re-hashed weights from
 *     CacheStorage, the works. *This* server-built bundle CANNOT
 *     include that, because Node has no access to the user's
 *     browser CacheStorage. The result it embeds is a "shape-only"
 *     placeholder that explains the limitation.
 *   - This route DOES include: the SRI manifest (read off disk from
 *     /.well-known/sri-manifest.json), the receipt hash from the URL,
 *     the receipt body when the receipts service can return it, and
 *     the offline verify.sh.
 *
 * In other words: this route's bundle proves the on-chain record
 * exists and is internally consistent. It cannot prove what the
 * user's browser cached — only the user can do that, with the chat
 * modal.
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildPortableExport,
  MAX_BUNDLED_RECEIPTS,
} from "@/lib/portable-export";
import type { IntegrityVerificationResult } from "@/lib/integrity-verification";
import { DEFAULT_WEBGPU_MODEL } from "@/lib/webgpu-inference";
import type { ReceiptV1 } from "@/lib/receipt";

export const runtime = "nodejs";

// Best-effort read of the SRI manifest off the public/ directory.
// In dev + standalone-server prod it lives under `public/.well-known/`;
// when missing (early CI builds), the bundle gracefully includes a
// stub via buildPortableExport's default.
async function readSriManifest(): Promise<unknown | undefined> {
  const manifestPath = path.join(
    process.cwd(),
    "public",
    ".well-known",
    "sri-manifest.json",
  );
  try {
    const buf = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(buf);
  } catch {
    return undefined;
  }
}

function receiptsServiceBase(): string | null {
  const url = process.env.NEXT_PUBLIC_RECEIPTS_SERVICE_URL;
  return url ? url.replace(/\/$/, "") : null;
}

async function fetchReceipt(hash: string): Promise<ReceiptV1[]> {
  const base = receiptsServiceBase();
  if (!base) return [];
  try {
    const res = await fetch(`${base}/v1/receipts/${encodeURIComponent(hash)}`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { receipt?: ReceiptV1 };
    return body.receipt ? [body.receipt].slice(0, MAX_BUNDLED_RECEIPTS) : [];
  } catch {
    return [];
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  const { hash } = await ctx.params;

  // Build a shape-only verification result. Marked `unavailable`
  // because the server can't see the user's CacheStorage — the
  // verifier-side script and README make this distinction explicit.
  const placeholderResult: IntegrityVerificationResult = {
    modelId: DEFAULT_WEBGPU_MODEL,
    overall: "unavailable",
    checks: [
      {
        label: "WebGPU available",
        pass: false,
        skipped: true,
        detail:
          "Server-built bundle — WebGPU detection is browser-only. Open the chat modal for a live local check.",
      },
      {
        label: "Local weight fingerprint computed",
        pass: false,
        skipped: true,
        detail:
          "Server cannot access the user's browser CacheStorage. The chat modal's bundle includes this; this one does not.",
      },
      {
        label: "On-chain registry reachable",
        pass: false,
        skipped: true,
        detail:
          "Re-run via verify.sh against the live Solana RPC. See README.md.",
      },
      {
        label: "On-chain hash matches local",
        pass: false,
        skipped: true,
        detail:
          "Requires the local fingerprint, which only the user's browser can produce.",
      },
    ],
    verifiedAt: new Date().toISOString(),
  };

  let sriManifest: unknown | undefined;
  try {
    sriManifest = await readSriManifest();
  } catch {
    sriManifest = undefined;
  }

  const origin =
    req.nextUrl.origin && req.nextUrl.origin !== "null"
      ? req.nextUrl.origin
      : "https://ghola.xyz";

  const receipts = await fetchReceipt(hash);

  const blob = await buildPortableExport({
    modelId: placeholderResult.modelId,
    result: placeholderResult,
    receipts,
    sriManifest,
    originHint: origin,
  });

  const shortHash = (hash || "unknown").slice(0, 12);
  const filename = `ghola-receipt-${shortHash}-verify.zip`;

  // Convert Blob (web) → ArrayBuffer for NextResponse body. NextResponse
  // accepts BodyInit; Blob is a valid BodyInit in the edge runtime but
  // typing through node-runtime is finicky, so go via arrayBuffer().
  const buf = await blob.arrayBuffer();
  // Touch MAX_BUNDLED_RECEIPTS so the export stays in sync if it ever
  // changes — also lets a curious reader find the constant via lsp.
  void MAX_BUNDLED_RECEIPTS;

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      // Document the server-vs-client distinction in a header too —
      // anyone scripting against this endpoint sees it without having
      // to unzip and read the README.
      "X-Ghola-Bundle-Source": "server",
      "X-Ghola-Bundle-Limitation":
        "no-live-cache-fingerprint;use-chat-modal-for-full-local-verification",
    },
  });
}
