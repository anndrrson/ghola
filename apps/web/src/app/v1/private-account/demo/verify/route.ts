import { NextResponse } from "next/server";
import { verifyPublicPrivateAgentDemoToken } from "@/lib/private-account-demo-receipt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return json({
      valid: false,
      signature_valid: false,
      receipt_hash_matches: false,
      reason_code: "review_proof_token_required",
    }, 400);
  }

  const result = verifyPublicPrivateAgentDemoToken(token);
  const status = !result.valid && (
    result.reason_code === "review_proof_signing_key_missing" ||
    result.reason_code === "review_proof_signer_did_mismatch"
  ) ? 503 : 200;
  const body = {
    ...result,
    verification_scope: "exact_no_submit_receipt_integrity",
    limitation:
      "A valid issuer signature proves this exact receipt was not altered. Venue execution, chain settlement, and TEE-vendor attestation are separate claims.",
  };
  if (request.headers.get("accept")?.includes("text/html")) {
    return html(body, status);
  }
  return json(body, status);
}

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function html(
  body: ReturnType<typeof verifyPublicPrivateAgentDemoToken> & {
    verification_scope: string;
    limitation: string;
  },
  status: number,
) {
  const receipt = body.valid ? body.receipt : null;
  const signerDid = body.valid ? body.signer_did : "";
  const receiptSha256 = body.valid ? body.receipt_sha256 : "";
  const title = body.valid ? "Exact receipt verified" : "Receipt not verified";
  const stateClass = body.valid ? "ok" : "bad";
  const workerState = receipt?.worker.ready && receipt.worker.attested_ready
    ? "Ready and attested when observed"
    : "Asleep or unavailable — paid compute was not started";
  const commitments = receipt
    ? [
        ["Policy", receipt.execution_ticket.policy_commitment],
        ["Private intent", receipt.execution_ticket.private_intent_commitment],
        ["Strategy", receipt.execution_ticket.strategy_commitment],
        ["Sealed envelope", receipt.execution_ticket.sealed_envelope_commitment],
        ["Work order", receipt.execution_ticket.work_order_commitment],
        ["Attestation", receipt.execution_ticket.attestation_commitment],
        ["Result", receipt.execution_ticket.result_commitment],
      ]
    : [];
  const rows = commitments.map(([label, value]) => `
    <div class="commitment"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></div>
  `).join("");
  const reason = body.valid ? "" : `<p class="reason">${escapeHtml(body.reason_code)}</p>`;
  const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${escapeHtml(title)} · Ghola</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#090b10;color:#f4f6fa}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -15%,#162036 0,transparent 42%),#090b10}
    main{width:min(720px,100%);margin:auto;padding:clamp(28px,7vw,72px) 20px 56px}.brand{font-size:13px;letter-spacing:.08em;color:#98a2b5}
    h1{font-size:clamp(32px,7vw,52px);line-height:1.02;letter-spacing:-.04em;margin:34px 0 14px}.lede{color:#aeb7c7;line-height:1.6;margin:0 0 28px}
    .state{display:inline-flex;align-items:center;gap:9px;border:1px solid;border-radius:999px;padding:9px 13px;font-size:13px}.state:before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
    .ok{color:#7ce7b1;border-color:#246749;background:#0e241b}.bad{color:#ff9b9b;border-color:#713c43;background:#28151a}
    .card{margin-top:18px;border:1px solid #242b39;background:rgba(15,18,25,.88);border-radius:18px;padding:20px;box-shadow:0 18px 60px rgba(0,0,0,.28)}
    .facts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px}.fact{border:1px solid #293142;border-radius:12px;padding:13px}.fact span{display:block;color:#8f9aaf;font-size:12px}.fact strong{display:block;margin-top:5px;color:#7ce7b1}
    dl{display:grid;grid-template-columns:132px 1fr;gap:11px 16px;margin:4px 0}dt{color:#8f9aaf;font-size:13px}dd{margin:0;overflow-wrap:anywhere;font-size:14px}
    h2{font-size:18px;margin:0 0 18px}.commitment{padding:12px 0;border-top:1px solid #232a38}.commitment:first-of-type{border-top:0}.commitment span{display:block;color:#8f9aaf;font-size:12px;margin-bottom:6px}
    code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;color:#d6def0;overflow-wrap:anywhere}.note{color:#8f9aaf;font-size:12px;line-height:1.55;margin-top:18px}.reason{font-family:ui-monospace,monospace;color:#ffb0b0}
    @media(max-width:520px){.facts{grid-template-columns:1fr}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:9px}}
  </style>
</head>
<body><main>
  <div class="brand">GHOLA · REVIEW RECEIPT</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="lede">This page checks the exact ticket opened from Ghola. It does not create a replacement receipt or start paid compute.</p>
  <div class="state ${stateClass}">${body.valid ? "Ed25519 signature and receipt hash match" : "Verification failed"}</div>
  ${reason}
  ${receipt ? `<section class="card">
    <dl>
      <dt>Receipt</dt><dd>${escapeHtml(receipt.execution_ticket.ticket_id)}</dd>
      <dt>Observed</dt><dd>${escapeHtml(receipt.checked_at)}</dd>
      <dt>Worker</dt><dd>${escapeHtml(workerState)}</dd>
      <dt>Signer</dt><dd><code>${escapeHtml(signerDid)}</code></dd>
      <dt>Receipt hash</dt><dd><code>${escapeHtml(receiptSha256)}</code></dd>
    </dl>
    <div class="facts">
      <div class="fact"><span>Wallet required</span><strong>No</strong></div>
      <div class="fact"><span>Deposit required</span><strong>No</strong></div>
      <div class="fact"><span>Order broadcast</span><strong>No</strong></div>
    </div>
  </section>
  <section class="card"><h2>Exact commitments</h2>${rows}</section>` : ""}
  <p class="note">${escapeHtml(body.limitation)}</p>
</main></body></html>`;
  return new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
