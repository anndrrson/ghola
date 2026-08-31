#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleCarryReleaseEvidence,
  DEFAULT_CARRY_EVIDENCE_PATH,
  verifyCarryReleaseEvidence,
} from "./verify-carry-release-evidence.mjs";

export function parseCarryAssemblyArgs(args) {
  const parsed = { candidatePath: "", lifecyclePaths: [], outputPath: DEFAULT_CARRY_EVIDENCE_PATH };
  let outputSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--candidate", "--lifecycle", "--output"].includes(flag)) {
      throw new Error(`carry_release_assembly_argument_invalid:${flag || "missing"}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`carry_release_assembly_value_missing:${flag}`);
    index += 1;
    if (flag === "--candidate") {
      if (parsed.candidatePath) throw new Error("carry_release_candidate_duplicate");
      parsed.candidatePath = value;
    } else if (flag === "--lifecycle") {
      parsed.lifecyclePaths.push(value);
    } else {
      if (outputSeen) throw new Error("carry_release_output_duplicate");
      outputSeen = true;
      parsed.outputPath = value;
    }
  }
  if (!parsed.candidatePath) throw new Error("carry_release_candidate_missing");
  if (parsed.lifecyclePaths.length < 2) throw new Error("carry_release_lifecycle_count_insufficient");
  if (new Set(parsed.lifecyclePaths.map((value) => resolve(value))).size !== parsed.lifecyclePaths.length) {
    throw new Error("carry_release_lifecycle_input_duplicate");
  }
  return parsed;
}

export async function assembleCarryReleaseEvidenceFile({
  candidatePath,
  lifecyclePaths,
  outputPath = DEFAULT_CARRY_EVIDENCE_PATH,
}, dependencies = {}) {
  if (!candidatePath) throw new Error("carry_release_candidate_missing");
  if (!Array.isArray(lifecyclePaths) || lifecyclePaths.length < 2) {
    throw new Error("carry_release_lifecycle_count_insufficient");
  }
  const resolvedInputs = [candidatePath, ...lifecyclePaths].map((path) => resolve(path));
  const resolvedOutput = resolve(outputPath);
  if (new Set(resolvedInputs).size !== resolvedInputs.length) {
    throw new Error("carry_release_input_duplicate");
  }
  if (resolvedInputs.includes(resolvedOutput)) throw new Error("carry_release_output_overlaps_input");
  const read = dependencies.readFile || readFile;
  const assemble = dependencies.assemble || assembleCarryReleaseEvidence;
  const verify = dependencies.verify || verifyCarryReleaseEvidence;
  const candidate = await readJson(candidatePath, read, "candidate");
  const lifecycles = await Promise.all(lifecyclePaths.map(async (path) => {
    const parsed = await readJson(path, read, "lifecycle");
    return parsed?.material && typeof parsed.material === "object" && !Array.isArray(parsed.material)
      ? parsed.material
      : parsed;
  }));
  const evidence = assemble({ candidate, lifecycles });
  const verified = await verify(evidence);
  if (verified?.ok !== true || verified.evidence_commitment !== evidence?.evidence_commitment) {
    throw new Error("carry_release_verification_result_invalid");
  }
  await atomicWriteJson(resolvedOutput, evidence, dependencies);
  return Object.freeze({ output_path: resolvedOutput, evidence, verified });
}

async function readJson(path, read, label) {
  let serialized;
  try {
    serialized = await read(resolve(path), "utf8");
  } catch {
    throw new Error(`carry_release_${label}_unreadable:${resolve(path)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`carry_release_${label}_json_invalid:${resolve(path)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`carry_release_${label}_object_required:${resolve(path)}`);
  }
  return parsed;
}

async function atomicWriteJson(outputPath, value, dependencies) {
  const makeDirectory = dependencies.mkdir || mkdir;
  const write = dependencies.writeFile || writeFile;
  const move = dependencies.rename || rename;
  const remove = dependencies.unlink || unlink;
  await makeDirectory(dirname(outputPath), { recursive: true });
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await write(temporaryPath, `${canonicalPrettyJson(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await move(temporaryPath, outputPath);
  } catch (error) {
    await remove(temporaryPath).catch(() => {});
    throw error;
  }
}

function canonicalPrettyJson(value) {
  return JSON.stringify(canonicalValue(value), null, 2);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]));
}

async function main() {
  const inputs = parseCarryAssemblyArgs(process.argv.slice(2));
  const result = await assembleCarryReleaseEvidenceFile(inputs);
  console.log(`[carry-release-evidence] assembled ${result.verified.evidence_commitment} -> ${result.output_path}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[carry-release-evidence] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
