import { NextRequest, NextResponse } from "next/server";

/**
 * Content-Security-Policy violation report sink.
 *
 * Browsers POST here whenever a script, style, or fetch violates the
 * CSP we declared in next.config.ts. The `report-uri` directive in
 * the CSP header points at this endpoint.
 *
 * What we DO with reports:
 * - Log them as structured JSON to stdout (Vercel/Render capture →
 *   wherever the operator forwards logs).
 * - Tag each report with the visitor's IP + UA so a coordinated
 *   probe is visible across multiple events.
 *
 * What we DO NOT do:
 * - Store reports server-side. Storing them creates a new attack
 *   surface (DoS via report flooding, PII in reports).
 * - Respond with anything other than 204 No Content. CSP report
 *   endpoints MUST respond fast or browsers stop reporting.
 *
 * Why this matters: in production, ghola.xyz ships an *enforcing*
 * CSP. Every violation = either (a) a legit bug we have to fix, or
 * (b) a hostile script injection attempt. Both are interesting; both
 * deserve operator visibility.
 *
 * Wire shape (Reporting API v1 + legacy report-uri):
 * - Legacy: `{"csp-report": { ... }}` — single object, application/csp-report
 * - v1:     `[{ "type": "csp-violation", "body": { ... } }, ...]` —
 *           array, application/reports+json
 *
 * We accept both. Each report is forwarded to console as one log line
 * so a `vercel logs --since 1h | grep csp-violation` flow Just Works.
 */

interface LegacyCspReport {
  "csp-report"?: {
    "blocked-uri"?: string;
    "violated-directive"?: string;
    "effective-directive"?: string;
    "original-policy"?: string;
    "document-uri"?: string;
    "source-file"?: string;
    "script-sample"?: string;
    "line-number"?: number;
  };
}

interface ReportApiEnvelope {
  type?: string;
  body?: Record<string, unknown>;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let parsed: unknown = null;
  try {
    parsed = await req.json();
  } catch {
    // Malformed JSON → silently drop. CSP endpoints must be fast +
    // tolerant; an attacker spamming bogus bodies shouldn't be able
    // to crash the route.
    return new NextResponse(null, { status: 204 });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const ua = req.headers.get("user-agent") ?? "unknown";
  const origin = req.headers.get("origin") ?? "unknown";

  const reports: Array<Record<string, unknown>> = [];

  // Reporting API v1: array of envelopes.
  if (Array.isArray(parsed)) {
    for (const env of parsed as ReportApiEnvelope[]) {
      if (env?.type === "csp-violation" && env.body) {
        reports.push(env.body);
      }
    }
  } else if (parsed && typeof parsed === "object") {
    // Legacy report-uri: single object with `csp-report` key.
    const legacy = parsed as LegacyCspReport;
    if (legacy["csp-report"]) {
      reports.push(legacy["csp-report"] as Record<string, unknown>);
    }
  }

  if (reports.length === 0) {
    // Got something but couldn't parse it as either shape. Log the
    // raw bytes truncated so an operator can still investigate.
    const raw = JSON.stringify(parsed).slice(0, 1000);
    // eslint-disable-next-line no-console
    console.warn(
      "[csp-violation] unrecognized-shape",
      JSON.stringify({ ip, ua: ua.slice(0, 200), origin, raw }),
    );
    return new NextResponse(null, { status: 204 });
  }

  for (const r of reports) {
    // eslint-disable-next-line no-console
    console.warn(
      "[csp-violation]",
      JSON.stringify({
        ip,
        ua: ua.slice(0, 200),
        origin,
        blocked_uri: r["blocked-uri"] ?? r.blockedURL ?? null,
        violated_directive:
          r["violated-directive"] ?? r.effectiveDirective ?? null,
        document_uri: r["document-uri"] ?? r.documentURL ?? null,
        source_file: r["source-file"] ?? r.sourceFile ?? null,
        script_sample: (r["script-sample"] ?? r.sample ?? "")
          .toString()
          .slice(0, 200),
        line_number: r["line-number"] ?? r.lineNumber ?? null,
      }),
    );
  }

  return new NextResponse(null, { status: 204 });
}

// Reporting API v1 also issues an OPTIONS preflight when the report
// comes cross-origin. Accept it explicitly so browsers don't suppress
// the actual POST.
export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
