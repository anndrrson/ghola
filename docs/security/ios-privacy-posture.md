# iOS privacy posture — Phase ζ on-device inference

This document is the iOS counterpart to
[native-models.md](./native-models.md) (Android) and complements
[SECURITY.md](../../SECURITY.md) (web). It scopes the privacy properties
the iOS build will ship with when Phase ζ-iOS lands, what an App Store
reviewer or independent auditor can verify, and where the trust chain
bottoms out.

Audience: an Anthropic-style security reviewer, an App Store reviewer
scrutinizing an on-device LLM claim, or the engineer wiring up Phase ζ.
Tone matches native-models.md: terse, factual, honest about gaps. Every
property below that requires code not yet written is tagged with the
sub-phase that lands it (ζ.1, ζ.2, …).

## The privacy claim, stated precisely

When Local mode is selected on iOS 17+ (Phase ζ target):

1. Prompt text and generated tokens never leave the device. Verifiable
   by the airplane-mode test (Section 11) and by reading
   `AI/LocalChatBackend.swift` (ζ.2). The inference path contains zero
   `URLSession` calls.
2. The MLX model artifact has a SHA-256 fingerprint computed via
   `CryptoKit.SHA256`, compared to a hash compiled into the IPA, and
   (Phase η-iOS) anchored on-chain in the same
   [`ghola-model-registry`](../../programs/ghola-model-registry/src/lib.rs)
   PDA the Android build reads — one registry, two platforms.
3. Wallet identity is bound via SIWS over MWA, same as Android. The
   IPA never holds a long-lived bearer for a centralized identity.

We do **not** claim defeat of jailbroken-device adversaries, side
channels against the Apple GPU during MLX inference, or invisibility to
Apple itself at the OS layer. Apple Intelligence, MetricKit, and the
system crash reporter all have ingestion paths. Sections 4–7 enumerate
each surface and the mitigation.

## iOS vs Android threat model differences

| Surface | Android | iOS |
|---|---|---|
| App sandbox enforcement | SELinux + Linux DAC | **Stronger** — kernel-mandatory, no sideload for non-jailbroken |
| Sideload malware path | Real (third-party stores) | **Effectively none** outside MDM |
| OS-level AI in text fields | None | **Apple Intelligence Writing Tools** auto-enabled on iOS 18+ |
| System pasteboard | Local | **Shared with Apple Intelligence** on iOS 18+ |
| Auto-enabled telemetry | None on AOSP/GrapheneOS | **MetricKit + system crash reporter on by default** |
| NPU attestation chain | None (NeuroPilot) | None (Neural Engine); MLX sidesteps by targeting Metal/GPU |
| "Private AI" distribution | Solana dApp Store | App Store / TestFlight (no Solana dApp Store on iOS) |

Net: iOS gives ghola a stronger sandbox for free but more default
telemetry surfaces to silence by hand.

## Network — App Transport Security configuration

The Phase ζ-iOS `Info.plist` mirrors the Android
[`network_security_config.xml`](../../android/app/src/main/res/xml/network_security_config.xml)
allowlist exactly. ATS defaults to TLS-only and rejects arbitrary loads;
the per-host exception list is the same release-only allowlist:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key><false/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><false/>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key>
    <dict>
        <key>ghola.xyz</key>
        <dict>
            <key>NSIncludesSubdomains</key><true/>
            <key>NSExceptionRequiresForwardSecrecy</key><true/>
        </dict>
        <key>ghola-api.onrender.com</key>
        <dict><key>NSIncludesSubdomains</key><false/></dict>
        <key>thumper-cloud.onrender.com</key>
        <dict><key>NSIncludesSubdomains</key><false/></dict>
        <key>huggingface.co</key>
        <dict><key>NSIncludesSubdomains</key><true/></dict>
        <key>api.anthropic.com</key>
        <dict><key>NSIncludesSubdomains</key><false/></dict>
        <key>dashscope-intl.aliyuncs.com</key>
        <dict><key>NSIncludesSubdomains</key><false/></dict>
        <key>accounts.google.com</key>
        <dict><key>NSIncludesSubdomains</key><false/></dict>
        <key>googleapis.com</key>
        <dict><key>NSIncludesSubdomains</key><true/></dict>
    </dict>
</dict>
```

`NSAllowsLocalNetworking=true` is retained for Bonjour / Ghola Home
discovery (`_ghola._tcp.` per `ios/project.yml`). It does **not** relax
TLS — local-network requests still require TLS unless they go to a
private IP.

`NSPinnedDomains` (ATS cert pinning) is **deferred to ζ.5**. Pinning the
model-download hosts cuts off a CDN-rotation attack class but introduces
a hard outage if HF rotates a leaf — the safer pin is the *model hash*,
which we already pin via `PinnedModelHashes`. `api.ghola.xyz` becomes a
pin candidate once HSTS is stable.

## Apple Intelligence opt-out

iOS 18 routes TextField content through Writing Tools and surfaces it
to Apple Intelligence. For the chat composer this is a leak: a
"Rewrite" tap on a prompt sends the prompt to Apple's models. Phase
ζ.3 ships a `PrivatePromptTextField` SwiftUI view:

```swift
TextField("Message", text: $draft)
    .textContentType(.none)
    .autocorrectionDisabled(true)
    .textInputAutocapitalization(.never)
    .keyboardType(.asciiCapable)        // disables Genmoji surfaces
    .writingToolsBehavior(.disabled)    // iOS 18+, the load-bearing call
```

`writingToolsBehavior(.disabled)` is the public WWDC24 API for apps
with a privacy reason to refuse Writing Tools. Genmoji + Image
Playground are gated by the same modifier plus the ASCII keyboard
restriction. Pre-iOS-18 it's a no-op.

## UIPasteboard handling

`UIPasteboard.general` is shared with Apple Intelligence on iOS 18+
and with any app that registers a paste handler. The composer must
never write a prompt or response to `.general`. Phase ζ.3 introduces a
scoped pasteboard:

```swift
let priv = UIPasteboard(name: .init(rawValue: "xyz.ghola.app.private"),
                       create: true)!
priv.setItems([[UTType.utf8PlainText.identifier: text]],
              options: [.localOnly: true,
                        .expirationDate: Date().addingTimeInterval(60)])
```

`.localOnly` blocks Handoff propagation; `.expirationDate` auto-clears
within 60 s. The composer's "Paste" reads from this scoped pasteboard
first and falls back to `.general` only when the user explicitly
invokes the system paste menu.

## MetricKit disablement

MetricKit subscribes to system performance and diagnostic deliveries
by default and ships a daily payload to Apple. The honest read: an app
can decline to *subscribe* (`MXMetricManager.shared.remove(self)`) and
refrain from registering any `MXMetricManagerSubscriber`, which is what
Phase ζ.4 does. Apple still collects the underlying telemetry at the
OS level — the app simply does not receive it. The correct claim to
make: **ghola receives no MetricKit payload**; we cannot speak for
Apple's OS-level collection. No `Info.plist` key disables MetricKit
collection; `MXMetricManagerEnabled` is not in Apple's documented
schema.

## Crash reporting

The system crash reporter is always on and uploads if the user opted
into "Share with App Developers" at device setup. A crash inside MLX
inference may capture prompt bytes in stack frames. ζ.4 mitigations:

1. **Defensive inference path.** All MLX calls in `LocalLlmBackend`
   are wrapped in `do/catch` and convert errors into UI-level
   `onError`. An unhandled MLX crash is a bug.
2. **Memory scrubbing on completion.** The prompt buffer is zeroed
   with `memset_s` before the `inout` parameter returns. This narrows
   the crash-capture window but does not eliminate it — KV-cache
   activations still hold inferable context.

We do **not** ship a custom SIGABRT handler that scrubs the core dump.
App Review treats custom handlers with suspicion and the complexity is
high. Residual gap: if MLX crashes mid-token, Apple's crash report may
include prompt fragments. Mitigation: "don't crash."

## App Sandbox + file storage

MLX artifacts (target: `mlx-community/Mistral-7B-Instruct-v0.3-4bit`,
`mlx-community/Qwen2.5-1.5B-Instruct-4bit`) live under
`~/Library/Application Support/Ghola/models/mlx/` — sandboxed and
excluded from iCloud Backup (ζ.2):

```swift
var url = try FileManager.default
    .url(for: .applicationSupportDirectory, in: .userDomainMask,
         appropriateFor: nil, create: true)
    .appendingPathComponent("Ghola/models/mlx", isDirectory: true)
var vals = URLResourceValues()
vals.isExcludedFromBackup = true
try url.setResourceValues(vals)
```

`isExcludedFromBackup = true` is the iOS-correct way to keep model
bytes (and any cached prompts) out of iCloud Backup and out of
encrypted Mac backups. `Documents/` is the wrong location — backed up
by default, visible in the Files app.

Integrity verification is the Swift port of Android's
`IntegrityVerifier`:

```swift
import CryptoKit
let h = try SHA256.hash(data: Data(contentsOf: url)) // chunked in ζ.2
let hex = h.map { String(format: "%02x", $0) }.joined()
guard hex == PinnedModelHashes.mlxMistral7Bv03Q4 else {
    throw IntegrityError.mismatch
}
```

Same observe-but-don't-enforce posture as Kotlin: `nil` today, flips
to a hex string at η-iOS.

## MLX framework telemetry audit

`mlx-swift` and `mlx-swift-examples` were audited by grepping `URL`,
`URLSession`, `NSURLConnection`, `os_log` upload paths, and `MetricKit`
imports:

- `mlx-swift` core (`Sources/MLX/`): no network references. Metal
  kernel dispatch only.
- `mlx-swift-examples` LLM loop (`Libraries/LLM/`): only network
  surface is `Hub` — a Hugging Face downloader — a one-time
  model-fetch gated on `LocalModelManager.downloadModel`. Same shape
  as Android's `ModelManager.downloadModel`.
- Metal does emit Metal Performance Shader counters to the OS for
  thermal/perf management. These counters do not include input tensor
  contents.

Audit outcome (ζ.2 sign-off): MLX adds no telemetry surface beyond the
HF fetch, which is already on the ATS allowlist.

## Neural Engine + Core ML trust trade

MLX targets the Apple GPU via Metal, not the Neural Engine. Core ML
is the only public path to the ANE. Phase ζ does **not** use Core ML.

- **MLX-only (chosen).** No reliance on Core ML's opaque per-device
  compiled bundle. No ANE attestation assumption. Slower on smaller
  devices; comparable to Android Mali on a modern A-series.
- **Core ML fallback (rejected).** Would unlock ANE acceleration but
  introduces the Core ML compiler as an unaudited trust step — same
  shape as the Android LiteRT-LM AOT problem, except Apple's compiler
  is even more opaque.

We revisit Core ML only if Apple ships ANE attestation or battery
measurements force the issue.

## Reproducible verification path

Same recipe as Android, different primitive:

```bash
curl -L "https://huggingface.co/mlx-community/Mistral-7B-Instruct-v0.3-4bit/resolve/main/model.safetensors" \
    | shasum -a 256
```

On-device, the same value is producible by pulling the artifact via
Xcode's Devices and Simulators ("Download Container…") and running
`shasum -a 256`. CryptoKit `SHA256` is identical math to coreutils.

The on-chain `weights_hash` field in `ghola-model-registry` is
content-addressed; the iOS port reads the same PDA the Android build
reads. **One registry, two clients, same canonical hash.**

This is the airplane-mode test, iOS edition: install IPA → pair wallet
via MWA → download model (the only network event) → enable airplane
mode → send a chat turn → tokens stream with no network access.

## App Store posture for "Private AI"

There is no Solana dApp Store on iOS — Apple's policies prevent the
Phantom-style alt-store path. iOS distribution is App Store or
TestFlight. The on-device LLM claim will be reviewed under the
"advertised functionality" clause; this document is the artifact App
Review reaches for.

Phase ζ.6 ships a public **Settings → Privacy Verification** screen:

1. The pinned SHA-256 for the loaded model.
2. The canonical SHA-256 from the on-chain registry PDA.
3. A "Verify Integrity Now" button that re-hashes the on-disk artifact.

This is the in-app equivalent of `ghola.xyz/security/audit-trail`.

## Honest gaps

What Phase ζ-iOS does **not** defend against:

- **MLX 4-bit quantization compiler trust.** mlx-community ships
  pre-quantized weights; the quantization is reproducible from the
  upstream FP16 weights but requires an Apple Silicon host with ~24 GB
  unified memory. We do not host a reproducer harness today.
- **Memory forensics on a jailbroken device.** Same as Android.
- **Side channels.** Power-trace and EM emanation attacks against the
  Apple GPU during inference are out of scope.
- **Apple's OS-level telemetry.** MetricKit subscribers can be
  removed; Apple's underlying collection at the OS layer cannot.
  Boot-time activation records, usage stats reported under "Improve
  Siri & Dictation," and Apple Intelligence private cloud metadata
  are surfaces ghola the app cannot silence.
- **Cert pinning.** Deferred to ζ.5. A CA compromise against
  `huggingface.co` would currently pass the post-download check *until
  the model hash compare runs* — the model hash compare is the
  principled defense and lands first.
- **App Store binary opacity.** The IPA delivered by the App Store is
  re-signed by Apple and may differ in non-functional metadata from a
  reproducible local build. Cf. the Android Play-signing-key
  equivalent.

## Reporting

`security@ghola.xyz`, same disclosure policy as
[SECURITY.md](../../SECURITY.md). iOS-path vulnerabilities that
exfiltrate a prompt or token while Local mode is selected — including
inadvertent flow to Apple Intelligence, MetricKit, or the system
pasteboard — are high-severity and treated on the shorter window.

## Sources

- [Apple, App Transport Security](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity)
- [Apple, `NSPinnedDomains`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nspinneddomains)
- [Apple, MetricKit framework](https://developer.apple.com/documentation/metrickit)
- [Apple, `MXMetricManager`](https://developer.apple.com/documentation/metrickit/mxmetricmanager)
- [Apple, `UIPasteboard`](https://developer.apple.com/documentation/uikit/uipasteboard)
- [Apple, `UIPasteboard.OptionsKey`](https://developer.apple.com/documentation/uikit/uipasteboard/optionskey)
- [Apple, `writingToolsBehavior(_:)`](https://developer.apple.com/documentation/swiftui/view/writingtoolsbehavior(_:))
- [Apple, Apple Intelligence developer docs](https://developer.apple.com/apple-intelligence/)
- [Apple, `URLResourceValues.isExcludedFromBackup`](https://developer.apple.com/documentation/foundation/urlresourcevalues/1779059-isexcludedfrombackup)
- [Apple, `FileManager.SearchPathDirectory`](https://developer.apple.com/documentation/foundation/filemanager/searchpathdirectory)
- [Apple, CryptoKit `SHA256`](https://developer.apple.com/documentation/cryptokit/sha256)
- [Apple, App Sandbox](https://developer.apple.com/documentation/security/app_sandbox)
- [Apple, examining crash report fields](https://developer.apple.com/documentation/xcode/examining-the-fields-in-a-crash-report)
- [`mlx-swift`](https://github.com/ml-explore/mlx-swift)
- [`mlx-swift-examples`](https://github.com/ml-explore/mlx-swift-examples)
- [mlx-community on Hugging Face](https://huggingface.co/mlx-community)
- [`ghola-model-registry` program](../../programs/ghola-model-registry/src/lib.rs)
- [Android counterpart — `network_security_config.xml`](../../android/app/src/main/res/xml/network_security_config.xml)
- [Android counterpart — `native-models.md`](./native-models.md)
