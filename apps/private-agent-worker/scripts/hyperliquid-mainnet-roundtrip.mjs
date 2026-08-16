#!/usr/bin/env node
process.stderr.write(
  "Retired unsafe entry point. Use `npm run canary:hyperliquid:mainnet:roundtrip`, " +
  "which runs the sealed hardened canary.\n",
);
process.exitCode = 1;
