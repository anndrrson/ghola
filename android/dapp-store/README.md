# Ghola dApp Store Publishing

This directory holds the Solana dApp Store release materials for the Android
client: listing copy, screenshots, release notes, and signed APKs.

Ghola's current store listing uses the Solana Mobile Publisher Portal-backed
CLI (`@solana-mobile/dapp-store-cli@1.0.0`). The older legacy mint flow in
`legacy-mint/` is kept for metadata history, but current submissions require a
Publisher Portal API key.

## Prerequisites

1. **Node.js 18+** and `npx`.
2. **The existing Ghola App NFT**: `GGy59nfUdjL1aXyoawPrcR4v2gEY2ioMDriAoJWXk1ef`.
3. **The Ornithopter publisher keypair** used by prior submissions:
   `/Users/andersonobrien/Downloads/orni/orni-mobile/publishing/keypair.json`.
4. **Publisher Portal API key** from
   `https://publish.solanamobile.com/dashboard/settings/api-keys`, exported as
   `DAPP_STORE_API_KEY`.
5. **Enough mainnet SOL** on that publisher keypair for minting and review
   submission fees.
6. **The real Ghola release keystore** from the Documents secret folder. Avoid
   the older `~/.android/ghola-release.keystore` decoy; store updates must keep
   certificate SHA-256 `fb6d833b43c0d16c7152eeb5ff2ead110dda6baf3d1222292b444f3058b95510`.

   ```
   source "/Users/andersonobrien/Documents/New project/secrets/ghola-release-signing.env"
   ```

## Workflow

1. **Build a signed release APK:**
   ```
   cd android
   set -a
   source "/Users/andersonobrien/Documents/New project/secrets/ghola-release-signing.env"
   set +a
   JAVA_HOME=$(/usr/libexec/java_home -v 17) ./gradlew :app:assembleSeekerRelease

   cp app/build/outputs/apk/seeker/release/app-seeker-release.apk dapp-store/app-release-signed.apk
   cp app/build/outputs/apk/seeker/release/app-seeker-release.apk dapp-store/legacy-mint/app-release.apk
   ```

   If Gradle outputs `app-release-unsigned.apk`, the signing env is missing and
   the APK is not submission-ready.

2. **Confirm assets** in this directory:
   - `assets/icon.png` (512x512 app icon)
   - `assets/screenshots/*.png` (Seeker screenshots)

3. **Run the local release checks:**
   ```
   ./check-release.sh dapp-store/app-release-signed.apk
   ```

4. **Publish the update to the Publisher Portal:**
   ```
   cd dapp-store
   export DAPP_STORE_API_KEY=...
   npx -y @solana-mobile/dapp-store-cli@1.0.0 \
     --apk-file ./app-release-signed.apk \
     --keypair /Users/andersonobrien/Downloads/orni/orni-mobile/publishing/keypair.json \
     --whats-new "$(cat release-notes.txt)"
   ```

## Review window

Solana Mobile's legacy flow estimates 1-2 business days for app update review.
If there is no response, follow up in the Solana Mobile developer channels with
the release NFT and submission date.

## Security

**DO NOT commit publisher keypairs, keystores, or signing env files.** The
publisher keypair controls the on-chain publisher account, and the release
keystore controls Android update continuity.
