# Native on-device models — integrity, verification, and the dApp Store posture

This document is the source of truth for ghola's on-device inference
integrity story on Android. It complements [SECURITY.md](../../SECURITY.md)
(which scopes the web client and the Private-mode enclave path) and
[local-mode-flash-memory.md](../local-mode-flash-memory.md) (which is the
product-level explainer for in-browser WebGPU inference). This file
covers what ships in the APK, what a reviewer can verify, and where the
trust chain bottoms out.

The audience is an a16z-style security reviewer or a Solana dApp Store
submission auditor. Tone matches SECURITY.md: terse, factual, honest
about gaps.

## The privacy claim, stated precisely

Ghola Android ships three on-device inference paths. When the user
selects **Local mode** (the default on the Solana Seeker — see
[`SecureStorage`](../../android/app/src/main/java/xyz/ghola/app/ai/SecureStorage.kt)
runtime selection) the following invariants hold:

1. Inference runs entirely in-process. No prompt text and no generated
   token leaves the device. Verifiable by airplane-mode test (Section 4).
2. The model artifact on disk has a SHA-256 fingerprint that is
   computable client-side, comparable to a hash compiled into the APK,
   and (Phase η, in progress) anchored on-chain in the
   [`ghola-model-registry`](../../programs/ghola-model-registry/src/lib.rs)
   Anchor program on Solana devnet.
3. Wallet identity is bound to Solana via SIWS (Sign In With Solana over
   Mobile Wallet Adapter). No email, no phone number, no Google
   Sign-In on the v0.4.0 path. Ghola the company never holds a signing
   key for the user.

What we do **not** claim:

- We do not claim defeat of physical-device adversaries with root.
- We do not claim defeat of side-channel attacks against the NPU or GPU.
- We do not claim the AOT-compiled NPU bundle (`.litertlm`) has been
  independently verified down to the silicon — Google's MediaTek
  compiler is a trust assumption. See Section 6.

### Threat model — mobile vs web

The mobile attack surface is materially smaller than the web one and
the threat model is correspondingly narrower:

| Vector | Web (SECURITY.md) | Android (this doc) |
|---|---|---|
| Malicious browser extension reads chat DOM | In scope — partially mitigated, see SECURITY.md | Out of scope — no extensions exist |
| Tampered CDN serves wrong client | Mitigated by SRI manifest | Mitigated by APK signing + Play/dApp Store distribution |
| Tampered model weights on disk | Mitigated by `computeLoadedWeightFingerprint` (web) | Mitigated by [`IntegrityVerifier`](../../android/app/src/main/java/xyz/ghola/app/ai/IntegrityVerifier.kt) (Android — observe-mode today, enforce on pin land) |
| Network exfiltration by runtime library | Not applicable (browser sandbox) | In scope — see telemetry audit (Section 6) |
| Coerced operator | Mitigated by attestation + wallet-native identity | Mitigated by wallet-native identity; no operator exists in Local mode |
| Physical-device adversary | Out of scope | Out of scope |

The mobile story is **simpler**. No CDN. No DOM. No extension. The
attack surface collapses to: (a) is the APK what was published, (b) is
the model what was published, (c) does the runtime actually keep its
bytes local. The next three sections answer each.

## Verification model — per shipping artifact

Every on-device model artifact has four anchors: source repository,
canonical SHA-256 hash, runtime that consumes it, and (Phase η,
on-chain) a `ghola-model-registry` PDA entry. The integrity check path
on Android is a Kotlin port of the web's
`computeLoadedWeightFingerprint`:
[`IntegrityVerifier.verifyFile`](../../android/app/src/main/java/xyz/ghola/app/ai/IntegrityVerifier.kt)
SHA-256s the file in 64 KiB chunks and compares to the pinned hash from
[`PinnedModelHashes`](../../android/app/src/main/java/xyz/ghola/app/ai/PinnedModelHashes.kt).

| Artifact | Source | Canonical SHA-256 | Runtime | Pin constant | Registry status |
|---|---|---|---|---|---|
| `qwen2.5-1.5b-instruct-q8_0.gguf` (~1.6 GB) | `Qwen/Qwen2.5-1.5B-Instruct-GGUF` on HF | TBD — placeholder, pin is `null` today | llama.cpp (JNI) | `PinnedModelHashes.QWEN_2_5_1_5B_Q8_GGUF_SHA256` | Not yet anchored |
| `Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task` | `litert-community/Qwen2.5-1.5B-Instruct` on HF | TBD — placeholder, pin is `null` today | MediaPipe LLM Inference API | `PinnedModelHashes.MEDIAPIPE_QWEN_2_5_1_5B_EKV1280_SHA256` | Not yet anchored |
| `Gemma-3-1B.litertlm` (AOT-compiled for MT6878) | `litert-community/Gemma-3-1B-NPU-MT6878` on HF | TBD — placeholder, pin is `null` today | LiteRT-LM via NeuroPilot (APU 655 NPU) | `PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256` | Not yet anchored; two-hash strategy planned (see below) |

Every value in the table above is **`null` in source today**. This is
intentional. [`IntegrityVerifier`](../../android/app/src/main/java/xyz/ghola/app/ai/IntegrityVerifier.kt)
documents the "observe-but-don't-enforce" mode in its class KDoc: when
the pin is `null` the verifier still hashes the file and returns the
record, but `match=true` with `reason="no expected hash pinned yet"`.
This lets the verifier ship today across the model lifecycle (see
[`LiteRtModelManager.isModelVerified`](../../android/app/src/main/java/xyz/ghola/app/ai/litert/LiteRtModelManager.kt)
and the sibling `ModelManager` for GGUF), and the moment the pinned
constants flip from `null` to real hex strings, enforcement turns on
without a behavior change in the comparator. Mismatch will delete the
on-disk artifact and surface `onError("integrity check failed: tampered
or wrong artifact")` to the UI.

The web counterpart at
[`apps/web/src/lib/webgpu-inference.ts::computeLoadedWeightFingerprint`](../../apps/web/src/lib/webgpu-inference.ts)
already enforces against `DEFAULT_WEBGPU_MODEL_WEIGHTS_HASH` for the
WebLLM Llama-3.2-1B default; the Android port lags by one step (pin
constants land, then enforcement is on).

### Recompute recipe — GGUF and `.task`

For artifacts hosted directly on Hugging Face (the GGUF and the
MediaPipe `.task`), the recompute is one curl plus one sha256sum:

```bash
# Qwen 2.5 1.5B q8 GGUF — llama.cpp path
curl -L "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q8_0.gguf" \
    | sha256sum
# MediaPipe .task bundle
curl -L "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv1280.task" \
    | sha256sum
```

On the device, the same value is producible by pulling the artifact
out of `getExternalFilesDir(null)/models/` via `adb pull` and running
`sha256sum` locally. The on-device verifier hashes in 64 KiB chunks with
`MessageDigest.SHA-256`; the math is identical to GNU coreutils
`sha256sum`.

### Recompute recipe — `.litertlm` (two-hash strategy)

LiteRT-LM artifacts are AOT-compiled per-SoC by Google's compiler. An
MT6878 (Dimensity 7300) bundle will not run on an MT6989 (D9300). The
filename on disk encodes the SoC tag — `Gemma-3-1B-D7300.litertlm` —
specifically so a silent runtime mismatch is impossible.

The two-hash strategy from the Phase η plan, mirrored by the Anchor
program's record shape, anchors **two** hashes per `.litertlm`:

1. The upstream `.tflite` input from Google's HF repo. This is what a
   supply-chain auditor compares against — "did Google publish this
   `.tflite`, and is it what we fed to the compiler?"
2. The compiled `.litertlm` output. This is what the on-device
   verifier compares against (`PinnedModelHashes.GEMMA_3_1B_LITERTLM_SHA256`).

The compiled-output hash is what the device enforces; the input-`.tflite`
hash lives on-chain alongside it so a third party can audit the
compilation step out-of-band if Google publishes the compiler's
expected fingerprint. Neither hash is pinned today (Phase γ.3 + Phase η
in [`zesty-giggling-charm.md`](../../.claude/plans/zesty-giggling-charm.md)).
The end-to-end self-compile recipe for the MT6878 (Seeker) bundle —
including the toolchain, hosting model, and an honest accounting of
gaps — is in [`docs/perf/aot-compile-mt6878.md`](../perf/aot-compile-mt6878.md).

### On-chain registry shape

The [`ghola-model-registry`](../../programs/ghola-model-registry/src/lib.rs)
program stores per-model:

```
weights_hash:    [u8; 32]   // SHA-256 of the artifact
model_lib_hash:  [u8; 32]   // SHA-256 of the runtime (WASM on web; n/a on mobile)
config_hash:     [u8; 32]   // SHA-256 of model config JSON
tokenizer_hash:  [u8; 32]   // SHA-256 of tokenizer.json
ipfs_cid:        String     // canonical IPFS pin
license_spdx:    String     // license identifier
```

Hash fields are immutable after `register_model`. The only way to
"correct" a wrong hash is `close_model` + `register_model`, which
produces a different PDA bump and a public close event. This is the
content-addressing invariant that gives the Tier 1A.5 a16z-thesis
claim ("anonymous users read the protocol, signed-in users write to
it") its teeth.

PDA derivation:
`["ghola-model", sha256(model_id)]`. Mirrored in the web client at
`apps/web/src/lib/model-registry.ts::deriveModelPda`. Anyone with a
Solana RPC URL can derive the PDA from the model id string and read the
record — no signature, no auth.

## Reproducible-build story

The Android APK that ships to Play / Solana dApp Store contains:

| Artifact | In APK? | Verifiable client-side? |
|---|---|---|
| Application code (Kotlin/Java) | Yes | Yes — APK signature + reproducible builds from `github.com/anndrrson/ghola` at the commit SHA in the manifest |
| llama.cpp JNI native library | Yes | Yes — bytes are in the APK, hashable by anyone with `adb pull`. Source is the pinned llama.cpp git SHA in `android/app/src/main/cpp/CMakeLists.txt` |
| MediaPipe LLM Inference API | Yes (Maven dep) | Indirect — verified via Google's Maven artifact signing |
| LiteRT-LM runtime | Yes (Maven dep) | Indirect — same as MediaPipe |
| Model weight files (GGUF / `.task` / `.litertlm`) | **No** — downloaded on first run | Yes — see Section 2 recompute recipes |
| Pinned hash constants | Yes (`PinnedModelHashes.kt`) | Yes — bytes are in the APK; future pins also anchored on-chain |
| AOT-compiled NPU binary trust chain | n/a | **No** — Google's MediaTek compiler is an opaque step; see Section 6 |

The model weights are intentionally **not** in the APK. The APK is
~30 MB; weights are ~1.6 GB. Shipping weights would push the APK past
the 150 MB base-APK Play Store limit and would require Asset Delivery,
which complicates the Solana dApp Store submission. Instead the APK
ships pinned hashes (and, once enforcement lands, will refuse to load a
mismatched download).

A reviewer can verify the build is reproducible by checking out the
ghola commit referenced in the dApp Store submission and rebuilding the
APK with the published Gradle invocation; the resulting `.apk`'s
classes.dex and native `.so` sections should be byte-identical modulo
the v2/v3 signature block. (Same reproducibility-CI posture as the web
bundle in SECURITY.md, except the runner is Gradle instead of
`npm run build`.)

## The "no network" test affordance

Local mode is testable in the simplest way possible by a reviewer who
distrusts everything in this document:

1. Install the APK and pair a Solana wallet via the dApp Store /
   Mobile Wallet Adapter flow.
2. Download the on-device model (Settings → Local model → Download).
   Wait for completion. This is the **only** step that uses the
   network.
3. Open the chat screen. Confirm the runtime is Local (not the cloud
   `EnvelopeCloudBackend` path).
4. Enable airplane mode. Confirm both Wi-Fi and cellular are off.
5. Send a chat message. Tokens stream into the UI. No network was
   contacted.

This works because the Local mode path
([`LocalChatBackend`](../../android/app/src/main/java/xyz/ghola/app/ai/LocalChatBackend.kt)
+ [`LocalLlamaBackend`](../../android/app/src/main/java/xyz/ghola/app/ai/llama/LocalLlamaBackend.kt))
contains zero HTTP calls. The only network code in the on-device
inference module is the model **download** path
([`ModelManager.downloadModel`](../../android/app/src/main/java/xyz/ghola/app/ai/llama/ModelManager.kt),
[`LiteRtModelManager.downloadModel`](../../android/app/src/main/java/xyz/ghola/app/ai/litert/LiteRtModelManager.kt))
which is gated on user action and observable in logs.

Reviewers who want to harden the test can use `adb shell tcpdump` (or
`pcap-net-cap`) on a rooted test device to confirm no packets exit the
process during a chat turn.

## Solana dApp Store posture

The submitted APK can credibly carry the "private AI" tag in the dApp
Store listing because of the chain of evidence below:

- **Wallet-bound auth.** SIWS via Solana MWA. No email, no Google
  Sign-In on the v0.4.0 surface. The `xyz.ghola.app` package never
  holds a long-lived bearer token tied to a centralized identity. See
  [project_ghola_v04_wallet_auth.md](../../docs/v0.5-on-device-email.md)
  for the broader v0.4.0 plan; the Android-side auth path lives in
  `SecureStorage` and the MWA glue code.
- **On-chain integrity registry.** [`ghola-model-registry`](../../programs/ghola-model-registry/src/lib.rs)
  is live on Solana devnet (program id
  `7hZ9oxHyFRpKHtH3jsa8NeH4HYGrPT7ZttDFtUX9naNS`). Every shipping
  model artifact will resolve to a public PDA that anyone can read
  without signing in.
- **Publicly-verifiable runtime fingerprinting.** The Kotlin
  `IntegrityVerifier` is open source at the path linked above. A
  reviewer can read the 40 lines that produce the on-device hash and
  satisfy themselves that the comparator is the comparator.
- **Reproducible APK.** Build the APK from the public source at the
  declared commit SHA and diff. Same posture as the web bundle in
  SECURITY.md.
- **No network in the inference path.** Provable by airplane-mode
  test (Section 4). The model-download path is a one-time event,
  gated on explicit user action.

The combination of (wallet identity) + (open-weight content-addressed
registry) + (open-source on-device comparator) + (reproducible APK) +
(in-process inference) is the dApp Store privacy story. None of the
links require trusting ghola the company.

## Honest gaps

What we are **not** defending against, in the same spirit as the
"What is NOT protected today" list in SECURITY.md:

- **The AOT compiler trust chain.** `Gemma-3-1B.litertlm` is the
  output of Google's MediaTek-targeted LiteRT-LM compiler. We can
  hash the input `.tflite` (Google publishes it) and we can hash the
  output `.litertlm` (we redistribute it). We cannot independently
  verify that the compiler did not insert a back door between the
  two. The mitigation is the two-hash strategy plus public anchoring
  on-chain — auditors can compare against Google's published bundle
  hash if/when Google publishes one. Until that day, **the compiler
  is a trust assumption**.
- **Memory forensics with physical device access.** A rooted device
  with `gdb` attached can read the prompt and the activations out of
  process memory. There is no software defense for this.
- **Side channels.** Power-trace, EM-emanation, and timing-channel
  attacks against the NPU/GPU during inference are out of scope. The
  practical exposure is low for chat workloads but not zero for
  high-value structured prompts.
- **Telemetry from runtime libraries.** llama.cpp is pure C++ and
  contains no telemetry path. MediaPipe and LiteRT-LM are Google
  libraries; the Phase η plan tasks a telemetry audit ("confirm
  LiteRT-LM, NeuroPilot, llama.cpp, PowerInfer all run without
  phone-home network calls. If any do, block at the Android app level
  via `NetworkSecurityConfig`"). The first half of that audit has now
  landed:
  [`network_security_config.xml`](../../android/app/src/main/res/xml/network_security_config.xml)
  is HTTPS-only (`cleartextTrafficPermitted="false"` in the
  `base-config`) and enumerates a per-host allowlist for every host
  the Kotlin codebase legitimately contacts —
  `ghola.xyz`/`api.ghola.xyz`, `ghola-api.onrender.com`,
  `thumper-cloud.onrender.com`, `huggingface.co` (incl. LFS subdomains),
  `api.anthropic.com`, `dashscope-intl.aliyuncs.com`,
  `accounts.google.com`, and `*.googleapis.com` (gmail, oauth2, www,
  storage). Every other host is blocked by the platform before the
  network stack sees the request. Inline XML comments at the top of
  that file enumerate the audited runtime libraries (LiteRT-LM,
  MediaPipe Tasks GenAI, llama.cpp NDK, ONNX Runtime, BouncyCastle)
  and confirm none of them have a documented phone-home in their
  public release notes. The strict policy is release-only; the debug
  variant at
  [`src/debug/res/xml/network_security_config.xml`](../../android/app/src/debug/res/xml/network_security_config.xml)
  permits localhost cleartext + user-installed CAs so Charles Proxy
  and LAN-hosted thumper-cloud still work in development. **Residual
  gap:** this is a *static* allowlist audit; we have not yet captured
  packet traces from each runtime library in isolation to confirm
  zero outbound attempts at the syscall level. A runtime library
  attempting to phone home will fail closed, but we have not
  exercised that failure mode in CI.
- **Pin enforcement timing.** Every value in `PinnedModelHashes` is
  `null` today; the verifier is in observe-mode. A malicious model
  download (MITM against the HF download URL, or a Hugging Face
  account compromise) would currently pass the post-download check.
  The mitigation is HTTPS to a well-known host; the principled fix
  is the pinned-hash flip, tracked by Phase η and the
  `scripts/compute-weights-manifest.mjs` adapter for non-MLC
  artifacts.
- **First-run model download is observable.** The user's ISP can see
  that they downloaded a 1.6 GB GGUF from `huggingface.co`. This
  reveals the model identity. It does not reveal any prompts or
  conversations. The mitigation (Tor, VPN) is the user's
  responsibility.

## Reporting

Email **security@ghola.xyz** per the disclosure policy in SECURITY.md.
Vulnerabilities affecting the on-device path — in particular, any
path that exfiltrates a prompt or a token from the device while Local
mode is selected — are high-severity and treated on the shorter
disclosure window.
