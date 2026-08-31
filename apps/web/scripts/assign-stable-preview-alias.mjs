import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function validateStablePreviewAssignment({ deployment, stableAlias, expectedSha, status }) {
  const deploymentUrl = httpsVercelUrl(deployment?.url || deployment);
  const aliasUrl = httpsVercelUrl(stableAlias);
  const readyState = String(deployment?.readyState || deployment?.state || "").toUpperCase();
  if (deployment?.target !== "preview") throw new Error("stable alias requires a Preview deployment");
  if (readyState !== "READY") throw new Error("Preview deployment is not ready");
  if (!aliasUrl.hostname.includes("-git-")) throw new Error("stable alias must be a Vercel branch alias");

  const identity = status?.release_identity;
  if (identity?.ready !== true) {
    throw new Error("Preview release identity is not green");
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedSha || "") || identity.web_commit_sha !== expectedSha) {
    throw new Error("Preview commit does not match the expected source commit");
  }
  if (new URL(identity.web_deployment_url).hostname !== deploymentUrl.hostname) {
    throw new Error("Preview release identity belongs to a different deployment");
  }
  const persistence = status?.private_account_persistence;
  if (
    persistence?.status !== "green" ||
    persistence?.ready !== true ||
    persistence?.verified !== true ||
    !["postgres", "blob"].includes(persistence?.store)
  ) {
    throw new Error("Preview private-account persistence is not read-verified");
  }
  return {
    deployment_hostname: deploymentUrl.hostname,
    stable_alias_url: aliasUrl.href.replace(/\/$/, ""),
    stable_alias_hostname: aliasUrl.hostname,
    web_commit_sha: expectedSha,
  };
}

async function main() {
  const [deploymentInput, aliasInput, expectedShaInput] = process.argv.slice(2);
  if (!deploymentInput || !aliasInput) {
    throw new Error("usage: assign-stable-preview-alias <deployment-url> <stable-alias> [expected-sha]");
  }
  const expectedSha = expectedShaInput || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const deploymentHostname = httpsVercelUrl(deploymentInput).hostname;
  const deployment = JSON.parse(execFileSync("vercel", ["inspect", deploymentHostname, "--json"], { encoding: "utf8" }));
  const status = await fetch(`https://${deploymentHostname}/v1/private-account/live-trading/status`, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Preview status request failed: ${response.status}`);
      return response.json();
    });
  const verified = validateStablePreviewAssignment({ deployment, stableAlias: aliasInput, expectedSha, status });

  execFileSync("vercel", ["alias", "set", verified.deployment_hostname, verified.stable_alias_hostname], { stdio: "inherit" });
  const aliasedStatus = await fetch(`${verified.stable_alias_url}/v1/private-account/live-trading/status`, { cache: "no-store" })
    .then((response) => response.json());
  validateStablePreviewAssignment({ deployment, stableAlias: aliasInput, expectedSha, status: aliasedStatus });
  console.log(`[stable-preview] ${verified.stable_alias_hostname} -> ${verified.web_commit_sha.slice(0, 12)}`);
}

function httpsVercelUrl(value) {
  const raw = String(value || "").trim();
  const url = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app")) {
    throw new Error("only HTTPS vercel.app Preview hosts are allowed");
  }
  if (url.username || url.password || url.port || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Preview host must not contain credentials, a port, or a path");
  }
  return url;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[stable-preview] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
