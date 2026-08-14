import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const safetyLocks = {
  GHOLA_PRIVATE_AGENT_REMOTE_EXECUTION_DISABLED: "true",
  GHOLA_PRIVATE_AGENT_SPEND_LOCKDOWN: "true",
  GHOLA_PRIVATE_AGENT_SPEND_ARMED: "false",
  GHOLA_PRIVATE_AGENT_WAKE_ON_USE_ENABLED: "false",
  GHOLA_PRIVATE_AGENT_JIT_PROVISIONING: "false",
  GHOLA_PUBLIC_AGENT_WAKE_ENABLED: "false",
  GHOLA_PUBLIC_LIVE_WORKER_WAKE_ENABLED: "false",
};

process.stdout.write("Ghola localhost safety lock: remote runtimes and live worker wake are disabled.\n");

const child = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], {
  env: { ...process.env, ...safetyLocks },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  process.stderr.write(`Could not start local Next.js: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
