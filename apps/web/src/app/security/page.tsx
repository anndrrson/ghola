import type { Metadata } from "next";
import { Footer } from "@/components/Footer";

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
    badge: "LIVE",
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
        v: "Per-message receipt signed by the provider Ed25519 key, with attestation hash and measurement. The Verify button cross-checks the user + provider signatures; Check on-chain queries the Solana anchor.",
      },
      {
        k: "Current status (v2)",
        v: "Private mode now seals end-to-end to an attested Nitro enclave. The cloud forwards opaque bytes only. When no attested enclave is in the pool, the route falls back to relay-plain and the receipt records the caveat honestly.",
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
    when: "Shipped",
    title: "Honest plumbing",
    items: [
      "Sovereignty Modes ship in the chat UI; mode preference persists per user",
      "Per-message receipts: Ed25519-signed bodies, verifiable from the badge popover",
      "Local mode routes to a locally-installed ghola-home and fails closed — never silently downgrades to the cloud",
    ],
  },
  {
    phase: "v2",
    when: "Shipped",
    title: "Sealed transport, attestation, on-chain anchor",
    items: [
      "/inference/sealed on the relay: client X25519-seals the request to an enclave key, relay forwards opaque bytes verbatim",
      "AWS Nitro Enclaves with verifiable quote chain pinned to AWS root + Ghola measurement allowlist",
      "Provider re-keys on every boot; the relay drops expired enclaves from the Private pool",
      "Receipts carry attestation_hash + measurement and a provider Ed25519 signature alongside the user's",
      "Hourly Merkle root of receipts anchored to Solana — Check on-chain in the receipt modal returns the batch tx + period",
      "Turnkey vault un-stubbed: production sealing/unsealing through HSM-backed wrap operations",
    ],
  },
  {
    phase: "v3",
    when: "Next",
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
            Security model · v2 — sealed transport live
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
                  <div className="flex items-center gap-2">
                    {"badge" in mode && mode.badge && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.22em] text-emerald-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        {mode.badge}
                      </span>
                    )}
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#6f798c]">
                      {mode.tag}
                    </span>
                  </div>
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
                user + provider signatures, and check the Merkle proof
                against the hourly Solana anchor.
              </p>
            </div>
            <pre className="lg:col-span-7 text-[11px] leading-relaxed text-[#cfd4dd] bg-[#08090d] border border-[#1e2a3a] rounded-lg p-6 overflow-x-auto font-mono">
{`{
  version:            1,
  job_id:             "<uuid>",
  mode:               "private" | "local" | "open",
  provider_id:        "<bs58 | local-webgpu | ghola-home/host>",
  enclave_key_id:     "<sha256>",           // populated in v2 Private
  attestation_hash:   "<sha256(quote)>",    // populated in v2 Private
  measurement:        "<hex PCR0..2>",      // populated in v2 Private
  model_id:           "<string>",
  input_token_hash:   "<sha256 of prompt>",
  output_token_hash:  "<sha256 of response>",
  issued_at:          <unix ms>,
  signer_did:         "<did:key:z…>",
  signature:          "<Ed25519 user>",
  provider_signature: "<Ed25519 enclave>"   // v2 only; null in v1
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

      {/* Local mode install steps — anchored so LocalSetupBanner can deep-link */}
      <section id="local" className="border-t border-[#1e2a3a]">
        <div className="mx-auto w-full max-w-5xl px-6 lg:px-12 py-20">
          <div className="flex items-baseline gap-6 mb-12">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              04 — Install Local mode
            </span>
            <span className="flex-1 h-px bg-[#1e2a3a]" />
          </div>
          <div className="grid lg:grid-cols-12 gap-10 lg:gap-16">
            <div className="lg:col-span-5">
              <h2 className="font-display text-3xl md:text-4xl leading-tight mb-6 font-medium">
                Run inference{" "}
                <span className="text-[#8b95a8]">on your machine.</span>
              </h2>
              <p className="text-[#8b95a8] leading-relaxed mb-4">
                ghola-home is a small macOS daemon that runs models locally
                through Ollama and exposes them to the web app over
                localhost. Once paired, Local mode routes every chat
                straight there — the message never leaves your machine.
              </p>
              <p className="text-[11px] text-[#6f798c] leading-relaxed">
                Linux + Windows builds land in v2. WebGPU fallback for
                small (≤3B) in-browser models also v2.
              </p>
            </div>
            <ol className="lg:col-span-7 space-y-5">
              <li className="grid grid-cols-[2rem_1fr] gap-4">
                <span className="font-display text-xl text-[#3da8ff]">1</span>
                <div>
                  <h3 className="text-[#eef1f8] font-medium mb-1.5">
                    Install Ollama
                  </h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed mb-2">
                    ghola-home runs inference through Ollama. Download
                    from ollama.com and pull a model:
                  </p>
                  <pre className="text-[11px] font-mono text-[#cfd4dd] bg-[#08090d] border border-[#1e2a3a] rounded p-3 overflow-x-auto">
{`brew install ollama
ollama pull llama3.2`}
                  </pre>
                </div>
              </li>
              <li className="grid grid-cols-[2rem_1fr] gap-4">
                <span className="font-display text-xl text-[#3da8ff]">2</span>
                <div>
                  <h3 className="text-[#eef1f8] font-medium mb-1.5">
                    Run ghola-home
                  </h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed mb-2">
                    Build from the monorepo and start with a dedicated
                    port so it doesn&apos;t collide with anything else:
                  </p>
                  <pre className="text-[11px] font-mono text-[#cfd4dd] bg-[#08090d] border border-[#1e2a3a] rounded p-3 overflow-x-auto">
{`cargo run -p ghola-home --release
# GHOLA_HOME_BIND=127.0.0.1:7878 by default`}
                  </pre>
                  <p className="text-sm text-[#8b95a8] leading-relaxed mt-2">
                    It logs a 6-digit PIN on startup. Keep that handy.
                  </p>
                </div>
              </li>
              <li className="grid grid-cols-[2rem_1fr] gap-4">
                <span className="font-display text-xl text-[#3da8ff]">3</span>
                <div>
                  <h3 className="text-[#eef1f8] font-medium mb-1.5">
                    Pair this browser
                  </h3>
                  <p className="text-sm text-[#8b95a8] leading-relaxed">
                    Open ghola, pick <span className="text-[#cfd4dd]">Local</span>{" "}
                    in the chat header. The setup banner appears under
                    the header — click <span className="text-[#cfd4dd]">Pair this browser</span>,
                    enter the PIN, done.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* Threat model band */}
      <section className="border-t border-[#1e2a3a] bg-[#0a0b10]">
        <div className="mx-auto w-full max-w-5xl px-6 lg:px-12 py-20">
          <div className="flex items-baseline gap-6 mb-12">
            <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8b95a8]">
              05 — Threat model
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
                Strong. A compromised host OS, hypervisor, or co-tenant
                cannot inspect enclave memory. Private mode pins requests
                to a Nitro enclave whose measurement matches the
                allowlist; the relay drops attestations that fail the
                quote chain.
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

      <Footer />
    </div>
  );
}
