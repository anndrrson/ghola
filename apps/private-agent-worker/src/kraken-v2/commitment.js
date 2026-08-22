import { createHash, createHmac } from "node:crypto";

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function sha256Hex(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex");
}

export function krakenCommitment(domain, value) {
  return `krv2_${domain}_${sha256Hex({ domain: `ghola/kraken-v2/${domain}`, value }).slice(0, 48)}`;
}

export function deterministicClientOrderId(secret, planCommitment, childIndex) {
  const digest = createHmac("sha256", secret)
    .update(`ghola/kraken-v2/cl-ord-id\0${planCommitment}\0${childIndex}`)
    .digest("hex");
  return `ghk-${digest.slice(0, 28)}`;
}
