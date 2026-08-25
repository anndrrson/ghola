import { fileURLToPath } from "node:url";

export function verifyPrivateWorkerRuntimeConfig(env = process.env) {
  if (env.VERCEL !== "1") return { skipped: true };

  const rawUrl = first(env,
    "GHOLA_PRIVATE_AGENT_EXECUTION_URL",
    "GHOLA_PRIVATE_AGENT_WORKER_URL",
    "PHALA_AGENT_ENDPOINT",
  );
  if (!rawUrl) throw new Error("Vercel release is missing the private worker URL");

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Vercel release has an invalid private worker URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Vercel release private worker URL must use HTTPS");
  }

  const workerAuth = first(env,
    "PRIVATE_AGENT_WORKER_CAPABILITY_SECRET",
    "GHOLA_WORKER_CAPABILITY_SECRET",
    "GHOLA_PRIVATE_AGENT_EXECUTION_TOKEN",
    "PRIVATE_AGENT_EXECUTION_TOKEN",
  );
  if (!workerAuth) throw new Error("Vercel release is missing private worker authentication");

  return { skipped: false, worker_host: url.host };
}

function first(env, ...keys) {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function main() {
  const result = verifyPrivateWorkerRuntimeConfig();
  console.log(result.skipped
    ? "[private-worker-runtime-config] skipped outside Vercel"
    : `[private-worker-runtime-config] verified ${result.worker_host}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
