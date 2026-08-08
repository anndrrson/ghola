import fs from "node:fs";

const checks = [
  ["crates/thumper-cloud/src/db.rs", "CREATE TABLE IF NOT EXISTS complimentary_access_passes"],
  ["crates/thumper-cloud/src/routes/billing.rs", "access pass belongs to another email"],
  ["crates/thumper-cloud/src/routes/billing.rs", "resolve_effective_access(row.0, row.1, grant).tier"],
  ["apps/web/src/app/api/billing/access-passes/redeem/route.ts", '"/api/billing/access-passes/redeem"'],
  ["apps/web/src/components/trade/HyperliquidCockpit.tsx", "buildHyperliquidExecutionVaultBundle"],
  ["apps/web/src/components/trade/HyperliquidCockpit.tsx", "withdrawals disabled"],
  ["scripts/issue-investor-pass.mjs", 'tier: "starter"'],
];

for (const [file, expected] of checks) {
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(expected)) throw new Error(`${file} is missing ${expected}`);
}

const cockpit = fs.readFileSync("apps/web/src/components/trade/HyperliquidCockpit.tsx", "utf8");
if (cockpit.includes('window.location.assign("/account?flow=hyperliquid-live")')) {
  throw new Error("The old self-redirecting setup path is still present");
}

process.stdout.write("investor-access-verification-ok\n");
