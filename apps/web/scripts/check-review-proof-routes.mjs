import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(scriptDirectory, "..");
const buildDirectory = process.env.GHOLA_NEXT_BUILD_DIR?.trim()
  ? path.resolve(process.env.GHOLA_NEXT_BUILD_DIR.trim())
  : path.join(applicationRoot, ".next");
const manifestPath = path.join(buildDirectory, "server", "app-paths-manifest.json");

const REQUIRED_ROUTES = [
  "/v1/private-account/demo/verification-key/route",
  "/v1/private-account/demo/verify/route",
];

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  fail(`cannot read Next app route manifest at ${manifestPath}: ${errorMessage(error)}`);
}

const builtRoutes = new Set(Object.keys(manifest));
const missing = REQUIRED_ROUTES.filter((route) => !builtRoutes.has(route));
if (missing.length > 0) {
  fail(
    `dedicated review route(s) missing from the production build: ${missing.join(", ")}. ` +
      "Without them, /v1/[...path] forwards reviewer verification to the generic upstream and returns 404.",
  );
}

process.stdout.write(
  `[review-route-guard] packaged ${REQUIRED_ROUTES.length} dedicated review routes; generic /v1 proxy cannot capture them\n`,
);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  process.stderr.write(`[review-route-guard] ${message}\n`);
  process.exit(1);
}
