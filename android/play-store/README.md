# Ghola Android Play Store Build

This directory tracks the normal Android distribution path for Google Play.
It is intentionally separate from the Solana Seeker dApp Store release.

## Build Target

- Flavor: `standard`
- Release task: `./gradlew :app:bundleStandardRelease`
- Artifact: `android/app/build/outputs/bundle/standardRelease/app-standard-release.aab`
- Target SDK: 35
- Distribution flag: `GHOLA_DISTRIBUTION=standard_android_play`
- Auth surface flag: `GHOLA_AUTH_SURFACE=turnkey_ready`

## Scope

The Play Store build keeps the base Android app flows and generic wallet sign-in.
Seeker-only copy, Seed Vault positioning, and Seeker Genesis Token proof remain in
the `seeker` flavor for Solana dApp Store submission.

Turnkey-native Android signing is the intended account surface for this flavor,
but the native Android client still needs the final Turnkey signer integration
before it can replace wallet adapter sign-in end to end.
