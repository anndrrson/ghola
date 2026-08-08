import process from "node:process";

const email = process.argv[2]?.trim().toLowerCase();
const apiBase = process.env.GHOLA_API_BASE?.replace(/\/$/, "");
const bearer = process.env.GHOLA_ADMIN_BEARER_TOKEN;
const adminSecret = process.env.GHOLA_INVESTOR_PASS_ADMIN_SECRET;

if (!email || !email.includes("@")) throw new Error("Usage: node scripts/issue-investor-pass.mjs investor@example.com");
if (!apiBase || !bearer || !adminSecret) {
  throw new Error("Set GHOLA_API_BASE, GHOLA_ADMIN_BEARER_TOKEN, and GHOLA_INVESTOR_PASS_ADMIN_SECRET");
}

const response = await fetch(`${apiBase}/api/billing/access-passes`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    "x-ghola-admin-secret": adminSecret,
  },
  body: JSON.stringify({ email, tier: "starter", grant_days: 14, redeem_days: 7 }),
});
const body = await response.json().catch(() => null);
if (!response.ok || !body?.invite_url) throw new Error(body?.error || `Access-pass issuance failed (${response.status})`);
process.stdout.write(`${body.invite_url}\n`);
