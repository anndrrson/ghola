import type { Metadata } from "next";

// Direct-share-only page. Linked from briefings, decks, and individual
// outreach — never from the public site chrome. The robots.txt blocks
// crawlers and this metadata.robots is the belt-and-suspenders layer
// so even if a crawler ignores robots.txt the page still tells it not
// to index. Flip both back on once v2 (real attestation) ships.
export const metadata: Metadata = {
  title: "Security — Ghola",
  description:
    "Sovereignty modes, attestation, receipts. How Ghola makes the privacy claim verifiable.",
  robots: { index: false, follow: false },
};

const MODES = [
  {
    num: "i",
    title: "Private",
    tag: "Default",
    blurb:
      "Encrypted to a verified provider. The relay forwards opaque bytes — we cannot decrypt your conversation.",
    rows: [
      {
        k: "Where plaintext exists",
        v: "Your browser, the provider enclave. Nowhere in between.",
      },
      {
        k: "Who holds the keys",
        v: "You hold the sealing key (Turnkey-signed master KEK). The enclave holds the unsealing key, generated in-enclave per boot.",
      },
      {
        k: "What you get as proof",
        v: "Per-message receipt signed by the provider Ed25519 key. Receipt includes attestation hash and measurement (v2).",
      },
      {
        k: "Current limitation (v1)",
        v: "Private mode currently shares the relay path with Open — the cloud sees plaintext today. The sealed transport (/inference/sealed) and AWS Nitro attestation land in v2. The label is honest about this on every chat: see the receipt body for what actually ran.",
      },
    ],
  },
  {
    num: "ii",
    title: "Local",
    tag: "On-device",
    blurb:
      "Runs on your laptop via WebGPU or ghola-home. The message never leaves the machine. You sign your own receipt.",
    rows: [
      {
        k: "Where plaintext exists",
        v: "Your device. Period.",
      },
      {
        k: "Who holds the keys",
        v: "You. The model weights, the prompt, and the receipt all stay on hardware you control.",
      },
      {
        k: "What you get as proof",
        v: "Self-signed receipt (Turnkey or ghola-home pair-device key). The proof says \"this never left my machine.\"",
      },
      {
        k: "Current limitation (v1)",
        v: "WebGPU path handles models up to ~3B parameters. Larger models need ghola-home (macOS today, Linux/Windows in v2).",
      },
    ],
  },
  {
    num: "iii",
    title: "Open",
    tag: "Unverified",
    blurb:
      "Any provider, plaintext path, cheapest route. Labeled unverified — for tasks where privacy is not the constraint.",
    rows: [
      {
        k: "Where plaintext exists",
        v: "Browser, relay, provider — every hop sees the message.",
      },
      {
        k: "Who holds the keys",
        v: "Effectively no one. The path is unencrypted.",
      },
      {
        k: "What you get as proof",
        v: "Mode tag only. The receipt says \"open,\" and the UI labels it accordingly.",
      },
      {
        k: "Current limitation (v1)",
        v: "This is the existing default for cost-sensitive or non-sensitive workloads. It exists so we never have to gatekeep — but the receipt makes the trade-off legible.",
      },
    ],
  },
] as const;

const ROADMAP = [
  {
    phase: "v1",
    when: "Now",
    title: "Honest plumbing",
    items: [
      "Sovereignty Modes ship in the chat UI; mode preference persists per user",
      "Per-message receipts: Ed25519-signed bodies (user-signed today), verifiable from the badge popover",
      "Local mode routes to a locally-installed ghola-home and fails closed — never silently downgrades to the cloud",
      "Private and Open still share the relay path. The relay sees plaintext today; sealed transport + attestation are the v2 cut",
    ],
  },
  {
    phase: "v2",
    when: "Next",
    title: "Sealed transport, attestation, on-chain anchor",
    items: [
      "/inference/sealed on the relay: client X25519-seals the request to an enclave key, relay forwards opaque bytes verbatim",
      "AWS Nitro Enclaves with verifiable quote chain pinned to AWS root + Ghola measurement allowlist",
      "Provider re-keys on every boot; the relay drops expired enclaves from the Private pool",
      "Receipts gain attestation_hash + measurement fields and a provider Ed25519 signature on top of the user's",
      "Hourly Merkle root of receipts anchored to Solana — any third party can verify a receipt without trusting Ghola's servers",
      "Turnkey vault un-stubbed: production sealing/unsealing through HSM-backed wrap operations",
    ],
  },
  {
    phase: "v3",
    when: "Later",
    title: "Multi-platform trust roots",
    items: [
      "NVIDIA H100 Confidential Compute for larger models",
      "Intel TDX / Phala — pick your trust root per chat",
      "Latency-aware routing inside the attested pool",
      "Open-source enclave images so anyone can rebuild and verify measurements byte-for-byte",
    ],
  },
] as const;

export default function SecurityPage() {
  return (
    <div className="min-h-screen pt-16 bg-[#08090d] text-[#eef1f8]">
      {/* Hero */}
      <section className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(1200px 600px at 70% 10%, rgba(61,168,255,0.08), transparent 60%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-5xl px-6 lg:px-12 pt-24 pb-20">
          <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#6f798c] mb-8">
            Security model · v1
          </div>
          <h1 className="font-display text-5xl md:text-7xl leading-[0.96] font-medium mb-8">
            Verifiably{" "}
            <span className="text-[#3da8ff]">off the record.</span>
          </h1>
          <p className="max-w-2xl text-lg text-[#8b95a8] leading-relaxed">
            Open, attested, sovereign confidential AI — TEE + on-device +
            on-chain accountable privacy, with a per-message cryptographic
            receipt the user can verify. This page is the honest version of
            that sentence: what we ship today, what we do not, and what
            comes next.
          </p>
        </div>
      </section>

      {/* Modes — three columns */}
      <section className="border-t border-[#1e2a3a]">
        <div className="mx-auto w-full max-w-7xl px-6 lg:px-12 py-20">
          <div className="flex items-baseline gap-6 mb-12">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              01 — Sovereignty modes
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>
          <div className="grid lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-[#1e2a3a] border-y border-[#1e2a3a]">
            {MODES.map((mode) => (
              <article key={mode.title} className="p-8 lg:p-10">
                <div className="flex items-center justify-between mb-8">
                  <span className="font-display text-3xl text-[#3da8ff]">
                    {mode.num}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f798c]">
                    {mode.tag}
                  </span>
                </div>
                <h2 className="font-display text-3xl mb-4">{mode.title}</h2>
                <p className="text-sm text-[#8b95a8] leading-relaxed mb-8">
                  {mode.blurb}
                </p>
                <dl className="space-y-5">
                  {mode.rows.map((row) => (
                    <div key={row.k}>
                      <dt className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f798c] mb-1.5">
                        {row.k}
                      </dt>
                      <dd className="text-sm text-[#cfd4dd] leading-relaxed">
                        {row.v}
                      </dd>
                    </div>
                  ))}
                </dl>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Receipts */}
      <section className="border-t border-[#1e2a3a] bg-[#0a0b10]">
        <div className="mx-auto w-full max-w-5xl px-6 lg:px-12 py-20">
          <div className="flex items-baseline gap-6 mb-12">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              02 — Receipts
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>
          <div className="grid lg:grid-cols-12 gap-10 lg:gap-16">
            <div className="lg:col-span-5">
              <h2 className="font-display text-3xl md:text-4xl leading-tight mb-6 font-medium">
                Every message ships with{" "}
                <span className="text-[#8b95a8]">a proof.</span>
              </h2>
              <p className="text-[#8b95a8] leading-relaxed">
                Receipts are signed records of where a message ran. They live
                in the chat vault next to the message, encrypted under the
                session key. Click the badge to see the body, verify the
                signature, and — in v2 — re-derive the Merkle proof against
                the Solana anchor.
              </p>
            </div>
            <pre className="lg:col-span-7 text-[11px] leading-relaxed text-[#cfd4dd] bg-[#08090d] border border-[#1e2a3a] rounded-lg p-6 overflow-x-auto font-mono">
{`{
  version:           1,
  job_id:            "<uuid>",
  mode:              "private" | "local" | "open",
  provider_id:       "<bs58 | local-webgpu | ghola-home/host>",
  enclave_key_id:    "<sha256>",            // v2 only
  attestation_hash:  "<sha256(quote)>",     // v2 only
  measurement:       "<hex PCR0..2>",       // v2 only
  model_id:          "<string>",
  input_token_hash:  "<sha256 of prompt>",
  output_token_hash: "<sha256 of response>",
  issued_at:         <unix ms>,
  signature:         "<Ed25519>"
}`}
            </pre>
          </div>
        </div>
      </section>

      {/* Roadmap */}
      <section className="border-t border-[#1e2a3a]">
        <div className="mx-auto w-full max-w-5xl px-6 lg:px-12 py-20">
          <div className="flex items-baseline gap-6 mb-12">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              03 — Roadmap
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>
          <ol>
            {ROADMAP.map((p) => (
              <li
                key={p.phase}
                className="grid grid-cols-[5rem_1fr] md:grid-cols-[7rem_1fr] gap-6 md:gap-10 py-8 border-t border-[#1e2a3a] last:border-b"
              >
                <div>
                  <div className="font-display text-3xl text-[#3da8ff]">
                    {p.phase}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f798c] mt-2">
                    {p.when}
                  </div>
                </div>
                <div>
                  <h3 className="text-xl text-[#eef1f8] mb-4">{p.title}</h3>
                  <ul className="space-y-2">
                    {p.items.map((it) => (
                      <li
                        key={it}
                        className="text-sm text-[#8b95a8] leading-relaxed pl-4 relative before:absolute before:left-0 before:top-2.5 before:h-1 before:w-1 before:rounded-full before:bg-[#3a4a60]"
                      >
                        {it}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Threat model band */}
      <section className="border-t border-[#1e2a3a] bg-[#0a0b10]">
        <div className="mx-auto w-full max-w-5xl px-6 lg:px-12 py-20">
          <div className="flex items-baseline gap-6 mb-12">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              04 — Threat model
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            <div>
              <h3 className="text-sm font-mono uppercase tracking-[0.18em] text-[#6f798c] mb-3">
                Network adversary
              </h3>
              <p className="text-sm text-[#cfd4dd] leading-relaxed">
                Strong. TLS plus end-to-end sealing means a passive or active
                network attacker sees ciphertext only.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-mono uppercase tracking-[0.18em] text-[#6f798c] mb-3">
                Software adversary
              </h3>
              <p className="text-sm text-[#cfd4dd] leading-relaxed">
                Strong in v2. A compromised host OS, hypervisor, or
                co-tenant cannot inspect enclave memory. Holds today only
                under the bare-metal Private path; full attestation arrives
                with Nitro.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-mono uppercase tracking-[0.18em] text-[#6f798c] mb-3">
                Physical adversary
              </h3>
              <p className="text-sm text-[#cfd4dd] leading-relaxed">
                Limited. TEEs are not unbreakable against well-funded
                physical attacks. We pair attestation with on-chain
                anchoring so detection survives a single-enclave
                compromise — Local mode is the recourse for the highest
                threat models.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
