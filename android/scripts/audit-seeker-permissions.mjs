#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const apkPath = process.argv[2] ||
  "app/build/outputs/apk/seeker/debug/app-seeker-debug.apk";
const allowed = new Set([
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.INTERNET",
  "xyz.ghola.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
]);

if (!existsSync(apkPath)) {
  console.error(`APK not found: ${apkPath}`);
  process.exit(2);
}

const aapt = findAapt();
if (!aapt) {
  console.error("aapt not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or install Android build tools.");
  process.exit(2);
}

const output = execFileSync(aapt, ["dump", "permissions", apkPath], {
  encoding: "utf8",
});
const permissions = [...output.matchAll(/uses-permission:\s+name='([^']+)'/g)]
  .map((match) => match[1])
  .sort();
const rejected = permissions.filter((permission) => !allowed.has(permission));

if (rejected.length > 0) {
  console.error("Seeker APK requests disallowed permissions:");
  for (const permission of rejected) console.error(`- ${permission}`);
  process.exit(1);
}

console.log("Seeker permission audit passed.");
console.log(`APK: ${apkPath}`);
console.log(`Permissions: ${permissions.length ? permissions.join(", ") : "none"}`);

function findAapt() {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
  ].filter(Boolean);
  for (const root of roots) {
    const buildTools = join(root, "build-tools");
    if (!existsSync(buildTools)) continue;
    const versions = readdirSync(buildTools)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(buildTools, version, "aapt");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
