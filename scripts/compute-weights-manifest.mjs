/**
 * Compute the canonical weights-manifest SHA-256 for a WebLLM model.
 *
 * The manifest is a sorted list of (file_path, lfs_sha256) pairs from
 * the model's HuggingFace repo, joined with newlines, then SHA-256
 * hashed. This gives a single 32-byte value that uniquely commits to
 * the model's weight files — independent of how the client fetches
 * them, what CDN they pass through, or whether HF itself is reachable.
 *
 * The output value is what register_model anchors on-chain as
 * weights_hash. The ghola-model-registry client compares the runtime
 * weight fingerprint (computed from the in-browser CacheStorage entries
 * after WebLLM finishes loading) against this hash.
 *
 * Note: HF stores its LFS objects' content addresses as `lfs.oid` in
 * its tree API. That oid IS the SHA-256 of the file bytes (HF uses
 * git-lfs with sha256 hashing). We don't need to download the actual
 * shards — the metadata API gives us the hashes for free.
 *
 * Usage:
 *   node scripts/compute-weights-manifest.mjs <repo> [revision]
 *   node scripts/compute-weights-manifest.mjs mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC main
 *
 * Output: prints the manifest body + the final hash to stdout.
 */
import { createHash } from "crypto";

const repo = process.argv[2] ?? "mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC";
const revision = process.argv[3] ?? "main";

async function main() {
  const url = `https://huggingface.co/api/models/${repo}/tree/${revision}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF API error ${res.status}: ${await res.text()}`);
  const items = await res.json();

  // We hash every LFS-tracked file in the repo. MLC repos typically
  // ship: params_shard_*.bin, ndarray-cache.json, mlc-chat-config.json,
  // tokenizer.json, tokenizer_config.json, tokenizer.model (some
  // models). The config + tokenizer are also SRI-pinned in
  // webgpu-inference.ts; including them here makes the on-chain
  // commitment redundantly cover both layers.
  const lfsFiles = items
    .filter((x) => x.type === "file" && x.lfs?.oid)
    .map((x) => ({ path: x.path, sha256: x.lfs.oid, bytes: x.size ?? 0 }));

  // Tiny non-LFS files (the JSON configs) get fetched + hashed
  // directly so they're part of the manifest. HF doesn't list a hash
  // for these in the tree API.
  const nonLfsFiles = items.filter(
    (x) => x.type === "file" && !x.lfs?.oid,
  );
  for (const f of nonLfsFiles) {
    const fileRes = await fetch(
      `https://huggingface.co/${repo}/resolve/${revision}/${f.path}`,
    );
    if (!fileRes.ok) continue;
    const body = Buffer.from(await fileRes.arrayBuffer());
    lfsFiles.push({
      path: f.path,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.byteLength,
    });
  }

  lfsFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestBody = lfsFiles.map((f) => `${f.path}\t${f.sha256}`).join("\n");
  const finalHash = createHash("sha256").update(manifestBody).digest("hex");

  console.log(`repo:     ${repo}`);
  console.log(`revision: ${revision}`);
  console.log(`files:    ${lfsFiles.length}`);
  console.log(
    `bytes:    ${lfsFiles.reduce((s, f) => s + f.bytes, 0)} (${(lfsFiles.reduce((s, f) => s + f.bytes, 0) / 1e9).toFixed(2)}GB)`,
  );
  console.log("");
  console.log("manifest:");
  for (const f of lfsFiles) {
    console.log(`  ${f.path}\t${f.sha256}  (${f.bytes}B)`);
  }
  console.log("");
  console.log(`weights_hash: ${finalHash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
