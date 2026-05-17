# Ghola iOS TestFlight and App Store Readiness

Status: readiness checklist for external TestFlight, public beta links, investor demos, and App Store review.

## Current submission stance

Ghola should be submitted as a private-first productivity and payments assistant, not as a fully offline app and not as shielded stablecoin infrastructure.

Accurate public claim:

> Ghola is an on-device-first agentic operating layer for work and commerce. Local chat and private memory stay on the phone by default; cloud, provider, and payment actions require explicit user approval.

Do not claim:

- Fully offline auth, wallet provisioning, billing, Gmail, calendar, calls, or public USDC settlement.
- Shielded USDC. Public Solana USDC exposes sender, recipient, amount, and timing on-chain.
- End-to-end privacy for third-party execution providers.
- Apple Foundation Models availability on every device or OS version.

## TestFlight gates

- Archive must build with a provisioning profile that includes every entitlement in `ios/Ghola.entitlements`.
- `ios/Ghola/PrivacyInfo.xcprivacy` must remain bundled in `Ghola.app`; it declares required-reason API usage and no tracking domains.
- Backend services must be live during review.
- External TestFlight requires beta review before the first external build is available.
- Provide reviewer credentials or a fully working sign-in path.
- TestFlight builds expire after 90 days.

## App Store review notes

Use notes like this:

```text
Ghola is a private-first AI assistant for work actions, native encrypted messaging, and user-approved stablecoin transfers.

Sign in:
- Sign in with Apple is supported.
- Email/Turnkey auth may be enabled for existing testers when the
  server-side Turnkey env flags are configured; Sign in with Apple is the
  review path.

Privacy:
- Local chat is the default where supported.
- Cloud chat and provider-backed actions are explicitly labeled before network use.
- Native Ghola messages are stored by Ghola Cloud as ciphertext relay records only.

Payments:
- USDC transfer support uses public Solana rails. Public-chain transactions reveal sender, recipient, amount, and timing on-chain.
- Ghola does not describe public USDC transfers as shielded.
- No chat-triggered payment sends are enabled in this build.

Reviewer path:
1. Sign in with Apple.
2. Open Chat and verify Local mode disclosure.
3. Open Messages and verify encrypted relay registration/sync.
4. Open Wallet and verify the public-chain disclosure before any transfer approval.
```

## Apple Developer portal blocker

The project now includes Sign in with Apple entitlement support. Before installing on device, archiving, or uploading to App Store Connect:

1. Open Certificates, Identifiers & Profiles.
2. Select the explicit App ID for `xyz.ghola.ios`.
3. Confirm Sign in with Apple is enabled and configured as the primary App ID.
4. Save the App ID changes if any settings changed.
5. Regenerate/download the iOS provisioning profile.
6. Rebuild/archive in Xcode.

Apple rejected `xyz.ghola.app` for team `8RRWJ4U2L7`; `xyz.ghola.ios` is the registered TestFlight App ID for this release. Changing the bundle identifier changes the installed app identity.

## Backend production gate

Set the production backend environment:

```sh
APPLE_CLIENT_ID=xyz.ghola.ios
```

Then deploy `thumper-cloud` and verify:

```sh
curl -s https://thumper-cloud.onrender.com/health | tr ',' '\n' | rg 'apple|google'
```

Expected: `apple=true`.

## Security and privacy review checklist

- Confirm Sign in with Apple tokens are verified server-side against Apple's JWKS, issuer, audience, and expiration.
- Confirm App Intents do not create external tasks without opening the app for approval.
- Confirm cloud chat is blocked in strict local mode unless the user explicitly selects cloud mode.
- Confirm task, email, calendar, call, wallet, and messaging APIs reject missing approval metadata where required.
- Confirm logs do not include prompts, phone numbers, email bodies, wallet addresses, recipient addresses, raw provider payloads, or plaintext message bodies.
- Confirm native messaging push payloads contain opaque IDs only.
- Confirm Wallet UI says public Solana USDC is not shielded.
- Confirm privacy policy includes AI providers, external providers, crypto rails, deletion/retention, and support contact.
- Confirm App Store Connect privacy labels match `ios/Ghola/PrivacyInfo.xcprivacy`: no tracking, app-functionality collection for account identifiers, contact info, user content, message/email bridge content, and wallet/financial metadata.

## Investor demo script

Lead with three concrete loops:

1. Local intelligence: open chat, show local/on-device mode, use airplane mode for a simple private prompt.
2. Delegated authority: create a work action and show the approval boundary before anything leaves the device.
3. Open payment rails: open Wallet, show USDC balance/address, and show the truthful public-chain disclosure before send approval.

The strongest a16z crypto framing is:

> Private user-owned agents need an operating layer: local intelligence, encrypted memory, delegated authority, spending limits, approvals, and open payment rails.

Keep the demo honest: Ghola minimizes off-chain leakage and puts the user in control, but public-chain settlement is public until a real shielded rail is configured.

## Commands used for release verification

```sh
cargo fmt --check -p thumper-cloud
cargo check -p thumper-cloud
xcodebuild -project ios/Ghola.xcodeproj -scheme Ghola_iOS -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
xcodebuild test -project ios/Ghola.xcodeproj -scheme Ghola_iOS -destination 'platform=iOS Simulator,id=<simulator-id>' CODE_SIGNING_ALLOWED=NO
```
