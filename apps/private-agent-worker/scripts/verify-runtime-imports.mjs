import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(workerDir, "../..");
const manifest = JSON.parse(readFileSync(resolve(workerDir, "package.json"), "utf8"));
const declaredPackages = new Set([
  ...Object.keys(manifest.dependencies || {}),
  ...Object.keys(manifest.optionalDependencies || {}),
]);
const visited = new Set();
const errors = new Set();
const importPattern = /(?:import\s+(?:[^'\"]*?\s+from\s+)?|export\s+[^'\"]*?\s+from\s+|import\s*\()(['\"])([^'\"]+)\1/g;

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function resolveRelativeImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, resolve(base, "index.js")];
  return candidates.find((candidate) => existsSync(candidate));
}

function assertTracked(file) {
  const pathFromRepo = relative(repoDir, file).replaceAll("\\", "/");
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", pathFromRepo], {
      cwd: repoDir,
      stdio: "ignore",
    });
  } catch {
    errors.add(`runtime dependency is not committed: ${pathFromRepo}`);
  }
}

function visit(file) {
  const absolute = resolve(file);
  if (visited.has(absolute)) return;
  visited.add(absolute);
  assertTracked(absolute);

  const source = readFileSync(absolute, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2];
    if (specifier.startsWith("node:")) continue;
    if (!specifier.startsWith(".")) {
      const dependency = packageName(specifier);
      if (!declaredPackages.has(dependency)) {
        errors.add(`undeclared runtime package ${dependency} imported by ${relative(repoDir, absolute)}`);
      }
      continue;
    }

    const target = resolveRelativeImport(absolute, specifier);
    if (!target) {
      errors.add(`missing runtime import ${specifier} from ${relative(repoDir, absolute)}`);
      continue;
    }
    visit(target);
  }
}

visit(resolve(workerDir, "src/server.js"));

if (errors.size > 0) {
  console.error("Private-agent worker runtime import validation failed:");
  for (const error of [...errors].sort()) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated ${visited.size} committed runtime modules.`);
