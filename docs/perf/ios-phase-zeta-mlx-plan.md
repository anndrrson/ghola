# Phase ζ-iOS — MLX-backed on-device LLM for the Ghola iOS app

Companion to [`phase-zeta-powerinfer-plan.md`](phase-zeta-powerinfer-plan.md)
(Android/Seeker). Cross-platform Phase ζ has two runtimes because
the SoCs do: Android ships PowerInfer + SmallThinker GGUF on
MediaTek/Snapdragon CPU cores; iOS would ship **MLX Swift on
Metal** on Apple Silicon GPU cores. Feasibility study + phased
plan, not a commit to ship.

## 1. Why MLX for iOS Phase ζ

Apple's "LLM in a flash" paper ([arXiv 2312.11514](https://arxiv.org/abs/2312.11514))
was written by the same group that built MLX, on Apple Silicon
with custom Metal kernels. If ghola wants a "canonical
Apple-paper" iOS story, MLX is the only honest path:

- **Same author lineage.** [ml-explore](https://github.com/ml-explore)
  publishes both MLX and mlx-lm; same team as the paper.
- **Swift bindings are official.** [`ml-explore/mlx-swift`](https://github.com/ml-explore/mlx-swift)
  ships from Apple Inc., MIT-licensed, via Swift Package Manager —
  no XCFramework vendoring, no CocoaPods.
- **Pre-converted weights exist.** The
  [mlx-community](https://huggingface.co/mlx-community) org hosts
  ~4,700 models in `.safetensors` with 4/8-bit groupwise quant.

This is the *opposite* tradeoff from Android. PowerInfer was picked
there because it's the only mobile runtime implementing the
paper's sparse-FFN / row-column-bundling on a shippable MoE
(SmallThinker). On iOS we don't get sparse loading either (§5) —
but we do get an Apple-blessed Metal LLM runtime.

## 2. iOS current state recap

`ios/Ghola/` is a pure SwiftUI cloud client. **No on-device LLM,
no `LlmBackend` protocol, no model storage.** Key files:

- `Services/CloudClient.swift` — `URLSession` actor → `api.ghola.xyz`.
- `Services/SSEClient.swift` — SSE streaming chat from cloud relay.
- `Services/SaidCloudClient.swift` — identity layer.
- `Models/LLMProvider.swift` — Codable structs for *cloud*
  providers only.
- `ios/project.yml` — XcodeGen, deployment iOS 17.0 / macOS 14.0.

Greenfield. Before MLX, the Kotlin `LlmBackend` interface needs a
Swift port — a `protocol LlmBackend` with
`generate(prompt:) -> AsyncStream<Token>`, model lifecycle hooks,
and a `CloudLlmBackend` wrapping the existing `SSEClient`. That
port is ζ-iOS.0, gating everything else.

## 3. MLX Swift integration

SPM dependency (from upstream
[`Package.swift`](https://github.com/ml-explore/mlx-swift/blob/main/Package.swift)):

```swift
.package(url: "https://github.com/ml-explore/mlx-swift", from: "0.31.0")
.package(url: "https://github.com/ml-explore/mlx-swift-examples", branch: "main")
```

Platform requirements:

- **mlx-swift**: macOS 14, iOS 17, tvOS 17, visionOS 1.
- **mlx-swift-examples** (LLM/VLM libraries): macOS 14, iOS 16
  (moot; mlx-swift forces 17).
- Apple Silicon only. The Linux excludes drop every Metal source;
  iOS has no Intel fallback. Practical floor: A14 (iPhone 12) or
  later. Frameworks linked: `Foundation`, `Metal`, `Accelerate`.

ghola's `ios/project.yml` already targets iOS 17 / macOS 14 — zero
deployment-target work.

**LLM API.** Runnable apps in `mlx-swift-examples/Applications/`:
`LLMBasic` (minimal chat), `LLMEval` (downloads weights, reports
tok/s), `MLXChatExample` (full chat, iOS + macOS, LLM + VLM). The
reusable library exposes a `ModelConfiguration` registry (default:
`phi4bit`), an async-stream `generate` API, and `LLMModelFactory`
to load safetensors + tokenizer.json. The supported integration
walkthrough is the [awni gist](https://gist.github.com/awni/fe4f96c21ead68e60191190cbc1c129b).

**Binary size.** Upstream publishes no number. The mlx-swift source
tree is ~7 MB; the compiled framework bundles the MLX C++ core.
Empirical third-party data suggests a `.ipa` adder of **40–80 MB**,
comparable to a llama.cpp XCFramework. Must measure in ζ-iOS.1.

**Entitlement.** iOS OOM-kills apps over the foreground budget
(~50% of physical RAM on older devices). Apple's escape hatch —
[`com.apple.developer.kernel.increased-memory-limit`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit)
— is required for any model >~1 GB. Must add to
`Ghola.entitlements`.

## 4. Available MLX models for Phase ζ-iOS

All sourced from [`mlx-community`](https://huggingface.co/mlx-community)
unless noted. Sizes are HuggingFace-reported `.safetensors` totals
for the 4-bit variant.

| Model | Size on disk | Quant | License | MLX variant exists | Notes |
|---|---|---|---|---|---|
| Llama-3.2-1B-Instruct-4bit | 695 MB | Q4 groupwise | Llama 3.2 Community | Yes | Workhorse default; ghola Android baseline |
| Llama-3.2-3B-Instruct-4bit | ~1.9 GB | Q4 | Llama 3.2 Community | Yes | Needs increased-memory entitlement |
| Phi-3.5-mini-instruct-4bit | 2.15 GB | Q4 | MIT | Yes | 3.8B dense; same family ghola is prepping for Android |
| gemma-3-1b-it-4bit | 733 MB | Q4 | Gemma | Yes | Google QAT variant also published |
| gemma-3-4b-it-4bit | ~2.4 GB | Q4 | Gemma | Yes | Multimodal-capable upstream |
| smallthinker-3b-preview-q4 | ~1.7 GB | Q4 | Apache 2.0 | Yes | **Older preview**, not the 4BA0.6B MoE |
| **SmallThinker-4BA0.6B-Instruct** | — | — | Apache 2.0 | **No** | Only community GGUF (`noctrex/...`) exists |
| Qwen3.5-4B-MLX-4bit | ~2.3 GB | Q4 | Apache 2.0 | Yes | Reasonable Phi-3.5 alternative |

File format is `.safetensors` (MLX moved away from `.npz` for
distribution). Quant is per-tensor groupwise — 4-bit weights,
fp16 activations, group size typically 64.

**Headline gap:** the exact model Android Phase ζ ships —
SmallThinker-4BA0.6B — **has no mlx-community conversion**.
Closest is the older `smallthinker-3b-preview-q4` (dense, not
the MoE). Producing the 4BA0.6B MLX variant is itself a research
task: `mlx_lm.convert` doesn't currently support SmallThinker's
MoE expert-routing op shape; a router port would need to land in
[mlx-lm](https://github.com/ml-explore/mlx-lm) first.

Symmetry breaks. Android Phase ζ = "SmallThinker-4BA0.6B via
PowerInfer." iOS Phase ζ realistically = **"Llama-3.2-3B-Instruct-4bit
via MLX"** — same memory budget, different architecture, different
quality story.

## 5. The Apple paper canonical implementation status

Highest-leverage finding:

**Apple has not open-sourced the implementation behind the "LLM
in a flash" paper.** The paper describes the algorithms
(windowing, row-column bundling, sparse predictor) and reports
M1 Max numbers, but the Metal kernels, predictor training code,
and bundled-weight format are in no public Apple repo.
`mlx-examples`, `mlx-lm`, and `mlx-swift-examples` contain dense
inference only.

Closest public artifact: [`matt-k-wong/mlx-flash`](https://github.com/matt-k-wong/mlx-flash) —
community, MIT, **Python-only, macOS 13+ only**. Wraps MLX with
"holistic model patching" to stream weights from SSD. **Not** a
port of the paper's predictor + windowing pipeline; different
design (predictive prefetcher + token bucket) targeting Mac SSDs,
not iPhone NAND. Does not run on iOS.

**Consequence.** "Canonical Apple-paper implementation on iOS" is
not something ghola integrates; it's something ghola *builds*.
Three options:

1. **Drop the paper framing on iOS.** Ship dense MLX inference of
   a model that fits (Llama-3.2-1B / Phi-3.5-mini). Framing
   becomes "on-device MLX," not "Apple paper on Apple Silicon."
2. **Cherry-pick MLX-compatible techniques.** Memory-mapped
   safetensors is a one-liner; pre-allocated buffer reuse is an
   `MLXArray` pattern; predictor head + sparse FFN routing are
   6–10 weeks of research work and need a model retrained or
   post-hoc analyzed for sparsity.
3. **Wait for Apple.** Paper is 2+ years old, MLX is active;
   plausible Apple ships it. No commitment now.

Recommendation: **(1) for ζ-iOS**, hold (2) and (3) open.

## 6. MLX (Metal) vs Core ML (Neural Engine) tradeoff

MLX runs on Apple Silicon GPU via Metal. The Neural Engine (ANE) —
the dedicated NPU that ships in every A-series chip from A11
onward — is reached only through Core ML. They are different
compute paths with different tradeoffs:

| Axis | MLX (Metal/GPU) | Core ML (ANE) |
|---|---|---|
| Generic LLM graph support | Native; dynamic shapes are fine | Hostile; ANE wants static shapes compiled AOT |
| KV cache, variable-length attention | First-class | Painful; ANE rejects shape-varying ops |
| MoE / sparse routing | Possible (active research) | Effectively not supported on ANE |
| Custom kernels | Metal Shading Language, supported | No public path |
| Battery (Wh/token) | GPU is power-hungrier than NPU | ANE is the most efficient unit |
| Model availability | mlx-community, hundreds of LLMs | A few hand-converted models (Mistral 7B, Whisper) |
| Apple's own LLM work | MLX is the public stack | Foundation Models (private system models only) |

Honest read: **for third-party LLMs, MLX is the only 2026-shippable
path.** Core ML's ANE backend is structurally unsuited to generic
LLM graphs; the [Orion paper (arXiv 2603.06728)](https://arxiv.org/abs/2603.06728)
catalogs 20 ANE restrictions LLM workloads trip. Apple's own
on-device LLM (Foundation Models) uses a private framework,
custom-engineered for those exact graphs.

For ghola: **MLX. Revisit Core ML only if Apple opens Foundation
Models to third parties** (no public roadmap).

## 7. Cross-platform integrity model

Android ships SHA-256 verification via `IntegrityVerifier` +
`PinnedModelHashes` (Phase η, in production). iOS equivalent:

- **Hash**: [`CryptoKit.SHA256.hash(data:)`](https://developer.apple.com/documentation/cryptokit/sha256) —
  bit-identical to Kotlin's `MessageDigest("SHA-256")`. Ships
  with the OS.
- **Pinned table**: Swift `PinnedModelHashes` struct mirroring
  the Kotlin one, populated from the same on-chain registry.
- **Registry**: `ghola-model-registry` Anchor program holds one
  hash per `(modelId, version, platform)`. iOS and Android read
  the same chain entry; file content differs (mlx safetensors vs
  PowerInfer GGUF), so each platform gets its own hash row.
- **Flow**: download → SHA-256 → compare pinned → compare pinned
  vs chain → load. Identical control flow to Android.

Port, not redesign. Estimate: 2–3 engineer-days once the Kotlin
pattern is settled, plus the iOS registry-read cost.

## 8. Implementation phases

Sequenced go/no-go gates analogous to Android's ζ.0–ζ.5.

### ζ-iOS.0 — `LlmBackend` protocol port (1 week)
- Translate Kotlin `LlmBackend` to Swift `protocol`.
- Implement `CloudLlmBackend` wrapping `SSEClient`. App works
  identically post-port; no MLX yet.
- Gate: cloud chat parity, protocol reviewed for MLX shape fit.

### ζ-iOS.1 — MLX dependency spike (3 days)
- Add `mlx-swift` + `mlx-swift-examples` via SPM.
- Build for real iOS device (simulator lacks Metal compute).
- Measure `.ipa` delta + cold-launch delta.
- Gate: binary delta ≤ 100 MB, cold-launch regression ≤ 300 ms.

### ζ-iOS.2 — `MLXLlmBackend` against Llama-3.2-1B-4bit (1 week)
- `MLXLlmBackend: LlmBackend` using `LLMModelFactory` +
  stream-generate. Wire integrity check (§7).
- Gate: streaming works on iPhone 15 / M-series iPad; tok/s ≥ 8;
  no thermal throttle in 60 s.

### ζ-iOS.3 — Settings + entitlement (3 days)
- MLX backend toggle (mirror Android). Add
  `increased-memory-limit` entitlement with App Review justification.
- Gate: TestFlight accepted, entitlement granted.

### ζ-iOS.4 — Larger opt-in models (1 week)
- User-downloadable Phi-3.5-mini, Gemma-3-4b from `mlx-community`.
  Memory warnings on ≤ 6 GB devices.
- Gate: 3B+ runs end-to-end on iPhone 15 Pro (8 GB), 20-turn convo,
  no OOM.

### ζ-iOS.5 — Real-device validation matrix (open-ended)
- iPhone 12 (A14/4 GB), 13 (A15/4 GB), 14 Pro (A16/6 GB),
  15 Pro (A17 Pro/8 GB), iPad M2, Mac M1.
- Capture tok/s, TTFT, energy (Instruments), peak RSS.
- Decision: ship matrix per model × device.

### ζ-iOS.6 (deferred) — Sparse-loading research
- Only if §5 option (2) is greenlit. Out of scope for initial ship.

## 9. Engineering investment estimate

Bottom-up by phase, single engineer, no parallelism:

| Phase | Estimate |
|---|---|
| ζ-iOS.0 protocol port | 1 week |
| ζ-iOS.1 MLX spike | 0.5 week |
| ζ-iOS.2 Llama-1B backend | 1 week |
| ζ-iOS.3 settings + entitlement | 0.5 week |
| ζ-iOS.4 larger models | 1 week |
| ζ-iOS.5 device matrix validation | 1–2 weeks |
| Integrity port (§7) | 0.5 week |
| Buffer for App Review, entitlement back-and-forth | 1 week |
| **Total** | **6.5–7.5 weeks** of engineering time |

This excludes ζ-iOS.6 (sparse loading research) which is open-ended
6–10 weeks of research-grade work — explicitly out of scope.

## 10. Honest risks

1. **No MLX variant of SmallThinker-4BA0.6B.** iOS ships
   Llama-3.2-3B or Phi-3.5-mini instead. Cross-platform story
   becomes "best on-device model per platform," not "same model
   everywhere." Comms challenge, not a blocker.
2. **Apple's paper implementation is not public** (§5). Either
   drop the framing or budget 6–10 weeks of research.
3. **MLX is GPU, not ANE.** The Neural Engine — the most
   power-efficient unit in every iPhone — is unreachable via MLX.
   Per-token energy will be higher than Apple's first-party
   Foundation Models story. No way around this in 2026.
4. **iOS memory ceiling is hard.** Even with the entitlement,
   the system can terminate mid-stream on 4 GB iPhones.
   Phi-3.5-mini (~2.2 GB weights + ~500 MB KV) is genuinely risky
   on iPhone 12/13. Model picker must reflect this.
5. **mlx-swift-examples library API is pre-1.0.** Breaking changes
   between minors expected; pin `.upToNextMinor` and budget
   quarterly upgrade time.
6. **App Review for the entitlement.** Approved for Pi, Private
   LLM, others — but rejection possible. Fallback: ≤ 1.5 GB
   models only.
7. **Cold-launch regression.** Loading even a 700 MB safetensors
   through MLX's lazy-array path adds first-token latency. Needs
   measurement; may need a warming task at app launch.

## 11. Sources

- [ml-explore/mlx-swift (Apple, MIT)](https://github.com/ml-explore/mlx-swift) — Swift API surface, platforms in [`Package.swift`](https://github.com/ml-explore/mlx-swift/blob/main/Package.swift)
- [ml-explore/mlx-swift-examples](https://github.com/ml-explore/mlx-swift-examples) — `LLMBasic`, `LLMEval`, `MLXChatExample`
- [ml-explore/mlx-examples (Python)](https://github.com/ml-explore/mlx-examples)
- [ml-explore/mlx-lm](https://github.com/ml-explore/mlx-lm)
- [mlx-swift Swift Package Index docs — running on iOS](https://swiftpackageindex.com/ml-explore/mlx-swift/0.25.6/documentation/mlx/running-on-ios)
- [awni gist — step-by-step LLM on iPhone with MLX Swift](https://gist.github.com/awni/fe4f96c21ead68e60191190cbc1c129b)
- [Apple "LLM in a flash" (arXiv 2312.11514)](https://arxiv.org/abs/2312.11514)
- [matt-k-wong/mlx-flash (community, MIT, Python, macOS only)](https://github.com/matt-k-wong/mlx-flash)
- [mlx-community on HuggingFace](https://huggingface.co/mlx-community)
- [mlx-community/Llama-3.2-1B-Instruct-4bit](https://huggingface.co/mlx-community/Llama-3.2-1B-Instruct-4bit)
- [mlx-community/Phi-3.5-mini-instruct-4bit](https://huggingface.co/mlx-community/Phi-3.5-mini-instruct-4bit)
- [mlx-community/gemma-3-1b-it-4bit](https://huggingface.co/mlx-community/gemma-3-1b-it-4bit)
- [mlx-community/smallthinker-3b-preview-q4](https://huggingface.co/mlx-community/smallthinker-3b-preview-q4)
- [Mungert/SmallThinker-4BA0.6B-Instruct (upstream, not MLX)](https://huggingface.co/Mungert/SmallThinker-4BA0.6B-Instruct)
- [Apple Developer — increased-memory-limit entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit)
- [Apple Developer — CryptoKit SHA256](https://developer.apple.com/documentation/cryptokit/sha256)
- [Orion: Characterizing and Programming Apple's Neural Engine (arXiv 2603.06728)](https://arxiv.org/abs/2603.06728) — ANE restrictions for LLM workloads
- [Ghola Phase ζ Android plan — `phase-zeta-powerinfer-plan.md`](phase-zeta-powerinfer-plan.md)
- [Ghola Phase η integrity model — `phase-zeta-derisk-d7300.md`](phase-zeta-derisk-d7300.md)
