import { fileURLToPath } from "node:url";

export const VERCEL_WEB_CONTEXT = "Vercel – web";

export function verifyVercelWebStatus(input) {
  const context = String(input.context || "").trim();
  const state = String(input.state || "").trim().toLowerCase();
  const description = String(input.description || "").trim();
  const targetUrl = String(input.targetUrl || "").trim();
  const sha = String(input.sha || "").trim();

  if (context !== VERCEL_WEB_CONTEXT) {
    throw new Error(`unexpected Vercel status context: ${context || "missing"}`);
  }
  if (state !== "success") {
    throw new Error(`Vercel web deployment is not successful: ${state || "missing"}`);
  }
  if (/cancel|ignored|skip|fail|error/i.test(description)) {
    throw new Error(`Vercel web deployment was not built: ${description || "missing description"}`);
  }
  if (!/deployment has completed|\bready\b/i.test(description)) {
    throw new Error(`Vercel web success is not a completed deployment: ${description || "missing description"}`);
  }
  if (!/^https:\/\/vercel\.com\//i.test(targetUrl)) {
    throw new Error("Vercel web deployment status is missing its deployment target URL");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new Error("Vercel web deployment status is missing a valid commit SHA");
  }

  return { context, state, description, target_url: targetUrl, sha };
}

function main() {
  const result = verifyVercelWebStatus({
    context: process.env.VERCEL_STATUS_CONTEXT,
    state: process.env.VERCEL_STATUS_STATE,
    description: process.env.VERCEL_STATUS_DESCRIPTION,
    targetUrl: process.env.VERCEL_STATUS_TARGET_URL,
    sha: process.env.VERCEL_STATUS_SHA,
  });
  console.log(`[vercel-web-gate] completed ${result.sha.slice(0, 12)} ${result.target_url}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
