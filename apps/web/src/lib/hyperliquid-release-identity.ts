import { gholaCommitment } from "@/lib/private-account";
import {
  GHOLA_HYPERLIQUID_NO_SUBMIT_ORDER_CONTRACT,
  GHOLA_HYPERLIQUID_PROOF_PROTOCOL,
} from "@/lib/hyperliquid-proof-protocol";

export type HyperliquidReleaseIdentity = {
  version: 1;
  ready: boolean;
  web_commit_sha: string | null;
  web_deployment_url: string | null;
  worker_image_digest: string | null;
  worker_expected_measurement: string | null;
  proof_protocol: string;
  no_submit_order_contract: string;
  release_identity_commitment: string | null;
  reason_codes: string[];
};

export function hyperliquidReleaseIdentity(
  env: Record<string, string | undefined> = process.env,
): HyperliquidReleaseIdentity {
  const webCommitSha = firstEnv(env, [
    "VERCEL_GIT_COMMIT_SHA",
    "GHOLA_RELEASE_COMMIT_SHA",
    "GITHUB_SHA",
  ]);
  const webDeploymentUrl = normalizedDeploymentUrl(firstEnv(env, [
    "VERCEL_URL",
    "GHOLA_RELEASE_DEPLOYMENT_URL",
  ]));
  const workerImageDigest = firstEnv(env, [
    "GHOLA_PRIVATE_AGENT_WORKER_IMAGE_DIGEST",
    "GHOLA_PRIVATE_AGENT_IMAGE_DIGEST",
    "PHALA_CVM_IMAGE_DIGEST",
  ]);
  const workerExpectedMeasurement = firstEnv(env, [
    "GHOLA_PRIVATE_RUNTIME_EXPECTED_MEASUREMENT",
    "GHOLA_PRIVATE_AGENT_EXPECTED_MEASUREMENT",
  ]);
  const workerArtifact = workerImageDigest || workerExpectedMeasurement;
  const reasonCodes = [
    webCommitSha ? null : "hyperliquid_release_web_commit_missing",
    webDeploymentUrl ? null : "hyperliquid_release_deployment_url_missing",
    workerArtifact ? null : "hyperliquid_release_worker_artifact_missing",
  ].filter((value): value is string => Boolean(value));
  const ready = reasonCodes.length === 0;
  const payload = ready ? {
    web_commit_sha: webCommitSha,
    web_deployment_url: webDeploymentUrl,
    worker_image_digest: workerImageDigest || null,
    worker_expected_measurement: workerExpectedMeasurement || null,
    proof_protocol: GHOLA_HYPERLIQUID_PROOF_PROTOCOL,
    no_submit_order_contract: GHOLA_HYPERLIQUID_NO_SUBMIT_ORDER_CONTRACT,
  } : null;
  return {
    version: 1,
    ready,
    web_commit_sha: webCommitSha || null,
    web_deployment_url: webDeploymentUrl || null,
    worker_image_digest: workerImageDigest || null,
    worker_expected_measurement: workerExpectedMeasurement || null,
    proof_protocol: GHOLA_HYPERLIQUID_PROOF_PROTOCOL,
    no_submit_order_contract: GHOLA_HYPERLIQUID_NO_SUBMIT_ORDER_CONTRACT,
    release_identity_commitment: payload
      ? gholaCommitment("hyperliquid_release_identity", payload)
      : null,
    reason_codes: reasonCodes,
  };
}

function firstEnv(env: Record<string, string | undefined>, names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function normalizedDeploymentUrl(value: string): string {
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
