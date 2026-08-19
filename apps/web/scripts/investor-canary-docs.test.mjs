import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [email, runbook, workerRunbook, verifier, runtime, tradePage, review, reviewModel, blotter] = await Promise.all([
  read("../../../docs/INVESTOR-CANARY-EMAIL.md"),
  read("../../../docs/INVESTOR-CANARY-ACCEPTANCE.md"),
  read("../../../docs/WORKER-DEPLOY-RUNBOOK.md"),
  read("investor-canary-live-verifier-lib.mjs"),
  read("investor-canary-live-verifier.mjs"),
  read("../src/app/trade/page.tsx"),
  read("../src/components/trade/TerminalLiveSubmitReview.tsx"),
  read("../src/lib/terminal-live-submit-review.ts"),
  read("../src/components/trade/TerminalLiveAccountBlotter.tsx"),
]);

const HUMAN_FLAGS = [
  "participant_is_non_operator",
  "invitation_email_opened",
  "verified_email_signup_or_signin_completed",
  "invite_fragment_scrubbed_before_redeem",
  "clean_chrome_profile_used",
  "worker_started_from_product",
  "phantom_evm_account_connected",
  "phantom_approve_agent_confirmed",
  "phantom_solana_account_connected",
  "phantom_siws_completed_if_requested",
  "graduation_wallet_binding_signature_confirmed",
  "graduation_exact_request_signature_confirmed",
  "first_terminal_entry_review_confirmed",
  "first_close_wallet_binding_signature_confirmed",
  "first_close_exact_request_signature_confirmed",
  "full_reload_between_round_trips",
  "second_terminal_entry_review_confirmed",
  "second_close_wallet_binding_signature_confirmed",
  "second_close_exact_request_signature_confirmed",
  "normal_terminal_entries_required_no_phantom_signature",
  "no_unexplained_repeated_prompt_or_stage_stall",
  "no_cli_dashboard_devtools_or_secret_setup",
  "confirmations_personally_completed",
];

test("investor email states the exact Phantom Ethereum, Solana, SIWS, and signing stages", () => {
  assert.match(email, /Do not copy the code or rewrite its `#access=` fragment as a `\?access=` query/u);
  assert.match(email, /both its Ethereum and Solana accounts available and unlocked/u);
  assert.match(email, /approve exactly one Hyperliquid `approveAgent` authorization/u);
  assert.match(email, /If direct connection cannot complete and Ghola shows \*\*Continue with Phantom\*\*, approve that SIWS sign-in once/u);
  assert.match(email, /exactly two scoped Solana messages: the wallet-binding challenge, then the exact graduation request/u);
  assert.match(email, /normal-terminal entry[\s\S]*does not request a Phantom message signature/u);
  assert.match(email, /Each \*\*Close HYPE · RO\*\*[\s\S]*exactly two scoped Solana messages/u);
  assert.match(email, /same stage repeats[\s\S]*stop and contact the sender[\s\S]*Do not resubmit/u);
  assert.doesNotMatch(email, /only.*Ethereum account unlocked/iu);
});

test("acceptance runbook and verifier share the complete human and operations contracts", () => {
  assert.match(runbook, /never redeems `\?access=` query parameters/u);
  assert.match(runbook, /captures only a valid `#access=` fragment and immediately replaces the visible URL/u);
  for (const flag of HUMAN_FLAGS) {
    assert.ok(runbook.includes(`\"${flag}\"`), `runbook missing ${flag}`);
    assert.ok(verifier.includes(`\"${flag}\"`), `verifier missing ${flag}`);
  }
  for (const key of [
    "rollback_artifact_commitment", "prior_release_artifact_commitment", "incident_owner_commitment",
    "kill_control_commitment", "reduce_only_recovery_commitment", "operator_email_commitments",
    "process_restart_observed", "receipt_replayed", "rebroadcast_performed",
  ]) {
    assert.ok(runbook.includes(`\"${key}\"`), `runbook missing ${key}`);
    assert.ok(verifier.includes(`\"${key}\"`), `verifier missing ${key}`);
  }
  for (const variable of [
    "GHOLA_INVESTOR_ACCEPTANCE_HUMAN_FILE",
    "GHOLA_INVESTOR_ACCEPTANCE_OPERATIONS_FILE",
    "GHOLA_INVESTOR_ACCEPTANCE_GITHUB_TOKEN",
  ]) {
    assert.ok(runbook.includes(variable), `runbook missing ${variable}`);
    assert.ok(runtime.includes(variable), `runtime missing ${variable}`);
  }
  assert.match(runbook, /offline dossier[\s\S]*always returns NO-GO/u);
  assert.match(runbook, /exact canceled\/no-fill readback for four TP\/SL children per investor/u);
  assert.match(runbook, /configured production observability and ready reconciliation/u);
  assert.match(runbook, /BuildKit metadata or worker self-report alone is insufficient/u);
  assert.match(runtime, /"--source-digest", release\.worker_git_sha/u);
  assert.match(runtime, /"--deny-self-hosted-runners"/u);
  assert.match(verifier, /WORKER_PROVENANCE_WORKFLOW = "github\.com\/anndrrson\/ghola\/\.github\/workflows\/build-private-agent-worker-image\.yml"/u);
});

test("terminal copy accurately describes venue protection and close prompts", () => {
  assert.doesNotMatch(tradePage, /One-shot live submit sends the entry limit only; it is not a bracket order/u);
  assert.match(tradePage, /Live submit binds the entry limit and venue-native take-profit\/stop-loss orders/u);
  assert.match(reviewModel, /venueProtection/u);
  assert.match(review, /Venue take-profit/u);
  assert.match(review, /Venue stop-loss/u);
  assert.match(review, /Submits the bound entry plus venue-native take-profit and stop-loss protection/u);
  assert.doesNotMatch(review, /Plan invalidation is not a venue stop or bracket/u);
  assert.match(blotter, /may first request SIWS/u);
  assert.match(blotter, /wallet-binding message and the exact reduce-only close request/u);
  assert.doesNotMatch(blotter, /requires a fresh wallet signature/u);
});

test("worker release runbook enforces one immutable guarded attempt", () => {
  for (const required of [
    "git status --porcelain",
    "investor-worker-release",
    "--signer-workflow",
    "--source-digest",
    "GHOLA_PRIVATE_AGENT_PROVISIONING_MUTATIONS_ENABLED=false",
    "GHOLA_PRIVATE_AGENT_IDLE_SHUTDOWN=false",
    "GHOLA_PHALA_SPEND_BRAKE_DISABLED=true",
    "CRON_SECRET=<strong scheduled-route secret>",
    "limit_order,cancel,reduce_only,stop_loss,take_profit",
    "Render Blueprint Auto Sync",
    "Stop and report the first failure",
  ]) {
    assert.ok(workerRunbook.includes(required), `worker runbook missing ${required}`);
  }
  assert.match(workerRunbook, /A failed or interrupted run is a stop, not a retry/u);
  assert.match(workerRunbook, /Never auto-retry a paid build, deploy, or[\s\n]+provision/u);
});

async function read(relative) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}
