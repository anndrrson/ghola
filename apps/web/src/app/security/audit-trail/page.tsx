"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Copy,
  ExternalLink,
  FileCheck2,
  Github,
  Hash,
} from "lucide-react";

// The "everything an auditor needs in five minutes" page. Pulls
// together every verifiable artifact the privacy claim depends on
// into a single audit checklist. A reviewer can land here, copy each
// `verify with` command, and reproduce the integrity story from their
// own terminal without trusting our backend or our marketing copy.
//
// Layout: one card per artifact, each with:
//   - what it is, in one line
//   - the live value (fetched at render time when applicable)
//   - the exact command a reviewer would run to verify it independently
//   - a copy-to-clipboard button on the command
//   - a link to the source of truth (GitHub, Solana explorer, etc.)
//
// Companion to /security/status. Status is the live probe board;
// audit-trail is the static reference card.

interface ManifestSnapshot {
  manifest_sha256: string | null;
  generated_at: string | null;
  git_commit: string | null;
  file_count: number | null;
}

const REGISTRY_PROGRAM_ID = "7hZ9oxHyFRpKHtH3jsa8NeH4HYGrPT7ZttDFtUX9naNS";
const DEFAULT_MODEL_PDA = "HdjQwHgGhk7wtRK36pGqW5GsL6StCbzveQwU7swDSQ9E";
const DEFAULT_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const DEFAULT_WEIGHTS_HASH =
  "8c3ae367d068c2b3a7d5b402a16395ab5089315e5256f609e54320d64d53c695";
const GITHUB_REPO = "https://github.com/anndrrson/ghola";

export default function AuditTrailPage() {
  const [manifest, setManifest] = useState<ManifestSnapshot | null>(null);
  const [cspHashCount, setCspHashCount] = useState<number | null>(null);

  useEffect(() => {
    void fetch("/.well-known/sri-manifest.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!b) return setManifest({ manifest_sha256: null, generated_at: null, git_commit: null, file_count: null });
        setManifest({
          manifest_sha256: b.manifest_sha256 ?? null,
          generated_at: b.generated_at ?? null,
          git_commit: b.git_commit ?? null,
          file_count: b.file_count ?? null,
        });
      })
      .catch(() => setManifest({ manifest_sha256: null, generated_at: null, git_commit: null, file_count: null }));

    void fetch("/.well-known/csp-inline-hashes.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && Array.isArray(b.hashes)) setCspHashCount(b.hashes.length);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-[#08090d] text-[#eef1f8]">
      <div className="mx-auto max-w-3xl px-6 py-16 lg:py-24">
        <Link
          href="/"
          className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8] hover:text-[#eef1f8]"
        >
          ← ghola
        </Link>
        <h1 className="mt-8 font-display text-4xl md:text-5xl leading-[1.0] font-medium">
          Audit trail
        </h1>
        <p className="mt-4 text-[#8b95a8] max-w-2xl leading-relaxed">
          Every verifiable artifact behind the privacy claim, in one
          place. Each row carries the exact command a reviewer would
          run to verify it independently — no trust in ghola required.
          Companion to{" "}
          <Link
            href="/security/status"
            className="text-[#3da8ff] hover:underline"
          >
            /security/status
          </Link>
          , which probes the same artifacts live.
        </p>

        <div className="mt-12 space-y-4">
          <ArtifactRow
            icon={<Github className="h-4 w-4" />}
            label="Source"
            value="anndrrson/ghola — main"
            evidence="Every commit deployed to ghola.xyz lives on this branch. The web client is built from apps/web/; the relay from crates/thumper-relay/."
            verifyCommand={`git clone ${GITHUB_REPO} && cd ghola && git rev-parse HEAD`}
            externalHref={GITHUB_REPO}
            externalLabel="GitHub"
          />

          <ArtifactRow
            icon={<Hash className="h-4 w-4" />}
            label="Web bundle integrity"
            value={
              manifest?.manifest_sha256
                ? `manifest_sha256 = ${manifest.manifest_sha256}`
                : "loading…"
            }
            evidence={
              manifest
                ? `${manifest.file_count ?? "?"} JS/CSS artifacts hashed; built ${manifest.generated_at ?? "?"}; commit ${manifest.git_commit ?? "?"}. Two builds at the same git SHA produce byte-identical hashes (CI-enforced).`
                : ""
            }
            verifyCommand={`curl -s https://ghola.xyz/.well-known/sri-manifest.json | jq '.manifest_sha256'\n\n# Rebuild from source and compare:\nGIT_COMMIT=$(git rev-parse HEAD) npm run build\ndiff <(jq -S . public/.well-known/sri-manifest.json) <(curl -s https://ghola.xyz/.well-known/sri-manifest.json | jq -S .)`}
            externalHref="https://ghola.xyz/.well-known/sri-manifest.json"
            externalLabel="manifest.json"
          />

          <ArtifactRow
            icon={<FileCheck2 className="h-4 w-4" />}
            label="Inline-script CSP allowlist"
            value={
              cspHashCount === null
                ? "loading…"
                : `${cspHashCount} pinned sha256 hashes`
            }
            evidence="Every inline <script> block Next.js emits is hashed at build time and listed in the CSP script-src directive. 'unsafe-inline' is removed; only pinned hashes execute."
            verifyCommand={`curl -s https://ghola.xyz/.well-known/csp-inline-hashes.json | jq '.hashes | length'\n\n# Verify CSP header enforcing:\ncurl -sI https://ghola.xyz/ | grep -i 'content-security-policy:'`}
            externalHref="https://ghola.xyz/.well-known/csp-inline-hashes.json"
            externalLabel="csp-inline-hashes.json"
          />

          <ArtifactRow
            icon={<Hash className="h-4 w-4" />}
            label="On-chain registry program"
            value={REGISTRY_PROGRAM_ID}
            evidence="Solana devnet. The web client reads this program at the deterministic PDA on every Local-mode chat session. Open-source: programs/ghola-model-registry/src/lib.rs."
            verifyCommand={`solana program show ${REGISTRY_PROGRAM_ID} --url devnet\n\n# Or via raw RPC:\ncurl -s -X POST -H 'Content-Type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["${REGISTRY_PROGRAM_ID}"]}' \\\n  https://api.devnet.solana.com`}
            externalHref={`https://explorer.solana.com/address/${REGISTRY_PROGRAM_ID}?cluster=devnet`}
            externalLabel="Solana Explorer"
          />

          <ArtifactRow
            icon={<Hash className="h-4 w-4" />}
            label="Default model record"
            value={`${DEFAULT_MODEL_PDA} (PDA for ${DEFAULT_MODEL_ID})`}
            evidence={`On-chain ModelRecord carries weights_hash = ${DEFAULT_WEIGHTS_HASH}. This hash is the SHA-256 of the canonical manifest of every file in mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC on HuggingFace (22 LFS shards + 3 inlined JSON configs).`}
            verifyCommand={`# Read the on-chain record:\nsolana account ${DEFAULT_MODEL_PDA} --url devnet --output json\n\n# Recompute the canonical hash:\nnode scripts/compute-weights-manifest.mjs ${DEFAULT_MODEL_ID}\n# Should print: weights_hash: ${DEFAULT_WEIGHTS_HASH}`}
            externalHref={`https://explorer.solana.com/address/${DEFAULT_MODEL_PDA}?cluster=devnet`}
            externalLabel="Solana Explorer"
          />

          <ArtifactRow
            icon={<FileCheck2 className="h-4 w-4" />}
            label="Receipt verifier"
            value="/r/[hash]"
            evidence="Public client-side verifier. Paste any receipt JSON; the page re-derives the canonical body, checks user signature, fetches the attestation doc, verifies the provider signature. No login. No server call to ghola for the math."
            verifyCommand={`# From an open chat session, click the receipt badge,\n# choose 'Open in verifier'. Or share the URL directly:\nopen https://ghola.xyz/r/<receipt-hash>?body=<base64-json>`}
            externalHref="https://ghola.xyz/r"
            externalLabel="/r"
          />

          <ArtifactRow
            icon={<FileCheck2 className="h-4 w-4" />}
            label="SECURITY.md disclosure policy"
            value="Threat model + RFC 9116 security.txt"
            evidence="Honest threat model with what is and is not protected. Vulnerability disclosure to security@ghola.xyz. Companion: docs/security/ has design docs for every Tier 2 + Tier 3 primitive."
            verifyCommand={`curl -s https://ghola.xyz/.well-known/security.txt\ncurl -s https://raw.githubusercontent.com/anndrrson/ghola/main/SECURITY.md`}
            externalHref="https://github.com/anndrrson/ghola/blob/main/SECURITY.md"
            externalLabel="SECURITY.md"
          />

          <ArtifactRow
            icon={<FileCheck2 className="h-4 w-4" />}
            label="Response headers (defense in depth)"
            value="HSTS · CSP enforcing · XFO DENY · COOP/COEP · CORP same-origin"
            evidence="Verified by the security-headers.test.ts vitest regression on every CI run. apps/web/next.config.ts is the source of truth."
            verifyCommand={`curl -sI https://ghola.xyz/ | grep -iE 'strict-transport|x-frame|content-security|content-type-options|referrer|permissions-policy|cross-origin'`}
            externalHref="https://github.com/anndrrson/ghola/blob/main/apps/web/src/lib/security-headers.test.ts"
            externalLabel="headers test"
          />
        </div>

        <div className="mt-12 text-[11px] text-[#6f798c] font-mono">
          this page is static + client-fetched at render time. last
          opened {new Date().toISOString()}.
        </div>
      </div>
    </div>
  );
}

interface ArtifactRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  evidence: string;
  verifyCommand: string;
  externalHref: string;
  externalLabel: string;
}

function ArtifactRow({
  icon,
  label,
  value,
  evidence,
  verifyCommand,
  externalHref,
  externalLabel,
}: ArtifactRowProps) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-2xl border border-[#1e2a3a] bg-[#0a0b10] p-5">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-[#3da8ff]">{icon}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8b95a8]">
          {label}
        </span>
      </div>
      <div className="font-mono text-xs text-[#eef1f8] break-all mb-3">
        {value}
      </div>
      {evidence && (
        <p className="text-xs text-[#8b95a8] leading-relaxed mb-4">
          {evidence}
        </p>
      )}
      <div className="rounded-lg border border-[#1e2a3a] bg-[#08090d] p-3 font-mono text-[11px] text-[#cfd4dd] whitespace-pre-wrap break-all leading-relaxed">
        {verifyCommand}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(verifyCommand);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#eef1f8] cursor-pointer"
        >
          <Copy className="h-3 w-3" />
          {copied ? "copied" : "copy verify command"}
        </button>
        <a
          href={externalHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-[#8b95a8] hover:text-[#3da8ff]"
        >
          <ExternalLink className="h-3 w-3" />
          {externalLabel}
        </a>
      </div>
    </div>
  );
}
