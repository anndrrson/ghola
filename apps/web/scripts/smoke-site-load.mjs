#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const DEFAULT_BASE_URL = "https://ghola.xyz";
const TIMEOUT_MS = positiveIntegerEnv("GHOLA_SITE_SMOKE_TIMEOUT_MS", 30_000);
const RENDER_WAIT_MS = positiveIntegerEnv("GHOLA_SITE_SMOKE_RENDER_WAIT_MS", 8_000);
const SCREENSHOT_PATH = resolve(
  process.env.GHOLA_SITE_SMOKE_SCREENSHOT_PATH || ".dev/site-smoke-failure.png",
);

const REQUIRED_TEXT = [
  "Private Mode for onchain finance.",
  "Use crypto apps without exposing your wallet.",
  "Before you send, see who can see your wallet.",
];

const baseUrl = normalizeBaseUrl(
  argValue("--base-url") ||
    process.env.GHOLA_SITE_SMOKE_BASE_URL ||
    process.env.GHOLA_WEB_BASE_URL ||
    process.env.GHOLA_WEB_URL ||
    DEFAULT_BASE_URL,
);

const report = {
  version: 1,
  base_url: baseUrl,
  checked_at: new Date().toISOString(),
  status: "running",
  checks: [],
  browser: null,
};

try {
  await checkHttpShell();
  await checkBrowserRender();
  report.status = "green";
} catch (error) {
  report.status = "red";
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "green") {
    if (process.env.GITHUB_ACTIONS === "true") {
      console.error(`::error::${report.error || "site smoke failed"}`);
    }
    process.exit(1);
  }
}

async function checkHttpShell() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(baseUrl, {
      signal: controller.signal,
      headers: {
        accept: "text/html",
        "cache-control": "no-store",
      },
    });
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") || "";
    const contentType = response.headers.get("content-type") || "";
    record("http_status", response.ok, {
      status: response.status,
      content_type: contentType,
      html_bytes: html.length,
    });
    record("html_shell_contains_app_copy", REQUIRED_TEXT.every((text) => html.includes(text)), {
      required_text_present: REQUIRED_TEXT.map((text) => ({ text, present: html.includes(text) })),
    });
    record("csp_allows_next_bootstrap", cspAllowsNextBootstrap(csp), {
      has_csp: Boolean(csp),
      script_src: scriptSrcDirective(csp),
    });

    if (!response.ok) fail(`homepage returned HTTP ${response.status}`);
    if (!contentType.toLowerCase().includes("text/html")) {
      fail(`homepage content-type is ${contentType || "missing"}, expected text/html`);
    }
    if (!REQUIRED_TEXT.every((text) => html.includes(text))) {
      fail("homepage HTML is missing required app copy");
    }
    if (!cspAllowsNextBootstrap(csp)) {
      fail("homepage CSP does not allow Next bootstrap scripts");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function checkBrowserRender() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const consoleFailures = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on("console", (message) => {
    const text = message.text();
    if (message.type() !== "error") return;
    if (isFatalConsoleError(text)) {
      consoleFailures.push({
        type: message.type(),
        text: text.slice(0, 700),
      });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error.stack || error.message || error).slice(0, 1_200));
  });
  page.on("requestfailed", (request) => {
    if (request.resourceType() === "document" || request.resourceType() === "script") {
      failedRequests.push({
        resource_type: request.resourceType(),
        url: redactUrl(request.url()),
        failure: request.failure()?.errorText || "unknown",
      });
    }
  });

  try {
    const response = await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT_MS,
    });
    await page.waitForTimeout(RENDER_WAIT_MS);
    const bodyText = await page.locator("body").innerText({ timeout: 5_000 });
    const visibleSignals = REQUIRED_TEXT.map((text) => ({
      text,
      present: bodyText.includes(text),
    }));
    const navOnlyShell =
      bodyText.includes("Sign In") &&
      bodyText.includes("Get Started") &&
      !bodyText.includes(REQUIRED_TEXT[0]);

    report.browser = {
      nav_status: response?.status() || null,
      title: await page.title(),
      text_bytes: Buffer.byteLength(bodyText, "utf8"),
      visible_signals: visibleSignals,
      console_failures: consoleFailures,
      page_errors: pageErrors,
      failed_requests: failedRequests,
    };

    record("browser_status", response?.ok() === true, { status: response?.status() || null });
    record("browser_rendered_app_copy", visibleSignals.every((signal) => signal.present), {
      visible_signals: visibleSignals,
      nav_only_shell: navOnlyShell,
    });
    record("browser_runtime_clean", consoleFailures.length === 0 && pageErrors.length === 0, {
      console_failure_count: consoleFailures.length,
      page_error_count: pageErrors.length,
    });

    if (response?.ok() !== true) fail(`browser navigation returned ${response?.status() || "no response"}`);
    if (navOnlyShell || !visibleSignals.every((signal) => signal.present)) {
      await saveFailureScreenshot(page);
      fail("browser did not render required homepage content");
    }
    if (consoleFailures.length || pageErrors.length) {
      await saveFailureScreenshot(page);
      fail("browser reported fatal runtime errors");
    }
  } finally {
    await browser.close();
  }
}

async function saveFailureScreenshot(page) {
  try {
    mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    writeFileSync(
      `${SCREENSHOT_PATH}.json`,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    report.failure_artifacts = {
      screenshot_path: SCREENSHOT_PATH,
      report_path: `${SCREENSHOT_PATH}.json`,
    };
  } catch (error) {
    report.screenshot_error = error instanceof Error ? error.message : String(error);
  }
}

function cspAllowsNextBootstrap(csp) {
  const scriptSrc = scriptSrcDirective(csp);
  if (!scriptSrc) return false;
  return scriptSrc.includes("'unsafe-inline'") ||
    scriptSrc.includes("'nonce-") ||
    scriptSrc.includes("'sha256-");
}

function scriptSrcDirective(csp) {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src ")) || "";
}

function isFatalConsoleError(text) {
  return /content security policy/i.test(text) ||
    /violates the following content security policy/i.test(text) ||
    /hydration/i.test(text) ||
    /minified react error/i.test(text) ||
    /connection closed/i.test(text) ||
    /failed to load resource/i.test(text);
}

function record(name, ok, detail = {}) {
  report.checks.push({
    name,
    ok: Boolean(ok),
    detail,
  });
}

function fail(message) {
  throw new Error(message);
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value || DEFAULT_BASE_URL);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid GHOLA_SITE_SMOKE_BASE_URL: ${value}`);
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.search = url.search ? "?<redacted>" : "";
    return url.toString();
  } catch {
    return String(value).slice(0, 200);
  }
}
