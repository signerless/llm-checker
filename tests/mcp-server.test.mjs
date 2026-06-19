// Integration/unit tests for bin/mcp-server.mjs robustness fixes.
//
// This file is ESM (.mjs) and is run directly by the suite via `node <file>`.
// It imports the MCP server module WITHOUT starting the stdio server (the
// module guards its top-level connect behind a runningAsEntry() check) and
// asserts against the exported pure helpers.

import assert from "assert";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, "..", "package.json");

import {
  SERVER_VERSION,
  readPackageVersion,
  tokensPerSecond,
  formatTokPerSec,
  mapHardwareJson,
  detectFrameworkMarker,
  FRAMEWORK_MARKERS,
} from "../bin/mcp-server.mjs";

function fail(msg) {
  console.error(`mcp-server.test.mjs: FAILED - ${msg}`);
  process.exit(1);
}

try {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));

  // (a) M6: advertised server version must equal package.json version (no drift).
  assert.strictEqual(
    SERVER_VERSION,
    pkg.version,
    `Advertised MCP server version (${SERVER_VERSION}) must equal package.json version (${pkg.version})`
  );
  assert.strictEqual(
    readPackageVersion(PKG_PATH),
    pkg.version,
    "readPackageVersion(package.json) must return the package version"
  );
  // Unreadable path falls back to "0.0.0" rather than throwing.
  assert.strictEqual(
    readPackageVersion(join(__dirname, "does-not-exist-package.json")),
    "0.0.0",
    "readPackageVersion should fall back to 0.0.0 on a missing file"
  );

  // (b) M2: tok/s helper must NOT return Infinity or a huge number when
  // eval_duration is missing/zero; it returns null (rendered "n/a").
  assert.strictEqual(
    tokensPerSecond(50, 0),
    null,
    "tokensPerSecond with eval_duration=0 must be null, not Infinity"
  );
  assert.strictEqual(
    tokensPerSecond(50, undefined),
    null,
    "tokensPerSecond with missing eval_duration must be null"
  );
  assert.strictEqual(
    tokensPerSecond(0, 1e9),
    null,
    "tokensPerSecond with eval_count=0 must be null"
  );
  assert.strictEqual(
    tokensPerSecond(undefined, undefined),
    null,
    "tokensPerSecond with no data must be null"
  );
  // Normal input: 100 tokens over 1e9 ns (1 second) => exactly 100 tok/s.
  assert.strictEqual(
    tokensPerSecond(100, 1e9),
    100,
    "tokensPerSecond(100, 1e9) must equal 100 tok/s"
  );
  // 250 tokens over 5e9 ns (5 seconds) => 50 tok/s, finite.
  const rate = tokensPerSecond(250, 5e9);
  assert.ok(Number.isFinite(rate) && Math.abs(rate - 50) < 1e-9, `expected 50 tok/s, got ${rate}`);

  // formatTokPerSec renders unavailable values as "n/a", finite values fixed.
  assert.strictEqual(formatTokPerSec(null), "n/a", "formatTokPerSec(null) must be 'n/a'");
  assert.strictEqual(formatTokPerSec(undefined), "n/a", "formatTokPerSec(undefined) must be 'n/a'");
  assert.strictEqual(formatTokPerSec(Infinity), "n/a", "formatTokPerSec(Infinity) must be 'n/a'");
  assert.strictEqual(formatTokPerSec(100), "100.0", "formatTokPerSec(100) must be '100.0'");

  // (c) M1: hardware JSON -> {tier, maxGB} extraction from a representative
  // object matching the real `hw-detect --json` shape.
  const hwFixture = {
    summary: {
      hardwareTier: "medium_high",
      totalVRAM: 24,
      effectiveMemory: 17,
      systemRAM: 24,
    },
  };
  const mapped = mapHardwareJson(hwFixture);
  assert.strictEqual(mapped.tier, "MEDIUM_HIGH", `tier must be upper-cased, got ${mapped.tier}`);
  assert.strictEqual(mapped.vramGB, 24, `vramGB must be 24, got ${mapped.vramGB}`);
  // maxGB = effectiveMemory - 2 headroom = 15 (mirrors detector.getMaxModelSize).
  assert.strictEqual(mapped.maxGB, 15, `maxGB must be 15 (17 - 2 headroom), got ${mapped.maxGB}`);

  // Fallback path: no usable fields -> tier UNKNOWN, vram null, maxGB sane 15.
  const empty = mapHardwareJson({});
  assert.strictEqual(empty.tier, "UNKNOWN", "empty JSON tier must be UNKNOWN");
  assert.strictEqual(empty.vramGB, null, "empty JSON vramGB must be null");
  assert.strictEqual(empty.maxGB, 15, "empty JSON maxGB must fall back to 15");

  // VRAM-derived fallback when effectiveMemory is absent.
  const vramOnly = mapHardwareJson({ summary: { totalVRAM: 12 } });
  assert.strictEqual(vramOnly.maxGB, 10, `maxGB must be 10 (12 - 2) when only totalVRAM present, got ${vramOnly.maxGB}`);

  // (d) M7: framework detector must recognize ".github" as "GitHub Actions"
  // (regression for the dotfile-skip-before-detection bug).
  assert.strictEqual(
    detectFrameworkMarker(".github"),
    "GitHub Actions",
    "detectFrameworkMarker('.github') must be 'GitHub Actions'"
  );
  assert.strictEqual(
    detectFrameworkMarker("package.json"),
    "Node.js",
    "detectFrameworkMarker('package.json') must be 'Node.js'"
  );
  assert.strictEqual(
    detectFrameworkMarker("not-a-marker.txt"),
    null,
    "detectFrameworkMarker on an unknown name must be null"
  );
  assert.strictEqual(FRAMEWORK_MARKERS[".github"], "GitHub Actions", "FRAMEWORK_MARKERS must contain .github");

  console.log("mcp-server.test.mjs: OK");
  process.exit(0);
} catch (err) {
  console.error("mcp-server.test.mjs: FAILED");
  console.error(err);
  process.exit(1);
}
