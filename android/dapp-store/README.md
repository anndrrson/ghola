# Ghola dApp Store Publishing

This directory holds the Solana dApp Store publishing config for the Android
client. It is used by `@solana-mobile/dapp-store-cli` to mint the on-chain
publisher/app/release records and submit the APK to the Solana Mobile store.

## Prerequisites

1. **Node.js 18+** and `npx`.
2. **A funded devnet Solana wallet** for the publisher account. The CLI will
   create three on-chain records (publisher, app, release) that each need a
   small amount of SOL.
3. **A release keystore** at `~/.android/ghola-release.keystore` (or any path
   exported as `GHOLA_KEYSTORE_PATH`). Store the passwords in your shell env
   or `~/.gradle/gradle.properties`:

   ```
   GHOLA_KEYSTORE_PATH=/absolute/path/to/ghola-release.keystore
   GHOLA_KEYSTORE_PASSWORD=...
   GHOLA_KEY_ALIAS=ghola
   GHOLA_KEY_PASSWORD=...
   ```

## Workflow

1. **Build a signed release APK:**
   ```
   cd android
   ./gradlew assembleRelease
   cp app/build/outputs/apk/release/app-release.apk dapp-store/app-release.apk
   ```

2. **Fill in the TODO assets** in this directory:
   - `assets/icon.png` (512x512 app icon)
   - `assets/screenshots/*.png` (6-8 screenshots at 1080x2400)

3. **Validate the config:**
   ```
   npx @solana-mobile/dapp-store-cli validate
   ```

4. **First publish — creates on-chain publisher + app + release records:**
   ```
   npx @solana-mobile/dapp-store-cli create publisher -k publisher.json
   npx @solana-mobile/dapp-store-cli create app -k publisher.json
   npx @solana-mobile/dapp-store-cli create release -k publisher.json \
     -b $ANDROID_HOME/build-tools/34.0.0
   ```

5. **Submit for review:**
   ```
   npx @solana-mobile/dapp-store-cli publish submit -k publisher.json
   ```

## Review window

Solana Mobile's review is manual and typically takes 3-10 business days. Keep
building against the submitted build — the next release is `publish update`
with the same publisher keypair.

## Security

**DO NOT commit `publisher.json` or any `.keystore` file.** Add them to
`.gitignore`. The publisher keypair controls the on-chain publisher account
and losing it means losing the dApp Store listing.
