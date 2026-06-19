#!/usr/bin/env node

/**
 * LLM Checker MCP Server
 *
 * Model Context Protocol server that exposes llm-checker tools to Claude Code
 * and other MCP-compatible AI assistants.
 *
 * Usage:
 *   claude mcp add llm-checker -- npx llm-checker-mcp
 *   # or
 *   claude mcp add llm-checker -- node node_modules/llm-checker/bin/mcp-server.mjs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readdir, stat } from "fs/promises";
import { readFileSync } from "fs";
import http from "http";
import os from "os";

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = join(__dirname, "enhanced_cli.js");
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// Read the package version dynamically so the advertised MCP server version
// never drifts from package.json. Falls back to "0.0.0" if unreadable.
function readPackageVersion(packagePath = PACKAGE_JSON_PATH) {
  try {
    const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function clean(text) {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\[\?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\([A-Z]/g, "")
    .trim();
}

async function run(args, timeout = 120000) {
  try {
    const { stdout, stderr } = await exec("node", [CLI_PATH, ...args], {
      timeout,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return clean(stdout || stderr);
  } catch (err) {
    // M8: the CLI exited non-zero. Do NOT silently return captured stdout as if
    // it succeeded — that masks failures from the caller (no error signal).
    // Throw so the tool handler's catch surfaces isError, while preserving the
    // captured output in the error message for diagnostics.
    const captured = clean(err.stdout || err.stderr || "");
    const detail = captured ? `${err.message}\n${captured}` : err.message;
    throw new Error(`llm-checker failed: ${detail}`);
  }
}

function ollamaAPI(path, body = null, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, OLLAMA_HOST);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      timeout,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama API timeout"));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return bytes + " B";
}

function nsToMs(ns) {
  return (ns / 1e6).toFixed(0);
}

function nsToSec(ns) {
  return (ns / 1e9).toFixed(2);
}

function tryParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ----------------------------------------------------------------------------

// M2: Compute generation speed in tokens/sec from an Ollama /api/generate
// response. Ollama reports durations in nanoseconds. Only compute a finite
// value when BOTH eval_count and eval_duration are positive; otherwise return
// null so callers can render "n/a" instead of dividing by a bogus 1ns fallback
// (which produced absurd numbers like billions of tok/s).
function tokensPerSecond(evalCount, evalDurationNs) {
  const count = Number(evalCount);
  const durNs = Number(evalDurationNs);
  if (!Number.isFinite(count) || !Number.isFinite(durNs)) return null;
  if (count <= 0 || durNs <= 0) return null;
  return (count / durNs) * 1e9;
}

// Format a tokens/sec value (possibly null) for display. Renders "n/a" when
// the value is unavailable, otherwise a fixed-precision number.
function formatTokPerSec(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(1);
}

// M1: Map the structured `hw-detect --json` object to the small set of facts
// the optimizer/cleanup tools need, sourced from typed fields instead of
// regex-scraping human-readable CLI text.
//   - tier:  summary.hardwareTier, upper-cased (e.g. "MEDIUM_HIGH"); "UNKNOWN" if absent.
//   - vramGB: summary.totalVRAM (unified/dedicated GPU memory budget).
//   - maxGB: largest model size that fits. Mirrors the detector's
//            getMaxModelSize(): effectiveMemory - 2GB headroom. Falls back to
//            totalVRAM/systemRAM derivations, then a sane 15GB default.
function mapHardwareJson(json) {
  const summary = (json && typeof json === "object" && json.summary) || {};

  const rawTier = summary.hardwareTier;
  const tier = typeof rawTier === "string" && rawTier.trim()
    ? rawTier.trim().toUpperCase()
    : "UNKNOWN";

  const vramGB = Number.isFinite(Number(summary.totalVRAM)) ? Number(summary.totalVRAM) : null;

  let maxGB;
  if (Number.isFinite(Number(summary.effectiveMemory))) {
    maxGB = Math.max(0, Math.round(Number(summary.effectiveMemory) - 2));
  } else if (Number.isFinite(Number(summary.totalVRAM)) && Number(summary.totalVRAM) > 0) {
    maxGB = Math.max(0, Math.round(Number(summary.totalVRAM) - 2));
  } else if (Number.isFinite(Number(summary.systemRAM)) && Number(summary.systemRAM) > 0) {
    maxGB = Math.max(0, Math.round(Number(summary.systemRAM) - 2));
  } else {
    maxGB = 15; // sane fallback when JSON lacks memory fields
  }

  return { tier, vramGB, maxGB };
}

// M7: Map of framework/marker filenames AND directories to their labels.
// Some markers are directories (e.g. ".github" -> "GitHub Actions") whose
// names start with a dot; the directory scan skips dotfiles, so these must be
// detected explicitly before the dotfile skip.
const FRAMEWORK_MARKERS = {
  "package.json": "Node.js",
  "Cargo.toml": "Rust/Cargo",
  "go.mod": "Go Modules",
  "requirements.txt": "Python/pip",
  "pyproject.toml": "Python",
  "Gemfile": "Ruby/Bundler",
  "pom.xml": "Java/Maven",
  "build.gradle": "Java/Gradle",
  "composer.json": "PHP/Composer",
  "Anchor.toml": "Solana/Anchor",
  "hardhat.config.js": "Ethereum/Hardhat",
  "foundry.toml": "Ethereum/Foundry",
  "CMakeLists.txt": "CMake",
  "Makefile": "Make",
  "Dockerfile": "Docker",
  "docker-compose.yml": "Docker Compose",
  ".github": "GitHub Actions",
  "next.config.js": "Next.js",
  "next.config.mjs": "Next.js",
  "vite.config.ts": "Vite",
  "tailwind.config.js": "Tailwind CSS",
  "tsconfig.json": "TypeScript",
};

// Returns the framework label for a given directory/file entry name, or null
// if the name is not a recognized marker. Pure + synchronous so it is unit
// testable (regression for M7: ".github" must resolve to "GitHub Actions").
function detectFrameworkMarker(name) {
  return Object.prototype.hasOwnProperty.call(FRAMEWORK_MARKERS, name)
    ? FRAMEWORK_MARKERS[name]
    : null;
}

function formatExportBlock(envObject) {
  if (!envObject || typeof envObject !== "object") return "";
  const entries = Object.entries(envObject).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `export ${key}="${String(value)}"`)
    .join("\n");
}

function summarizeOllamaPlan(payload) {
  if (!payload || typeof payload !== "object") return null;
  const plan = payload.plan;
  if (!plan || typeof plan !== "object") return null;

  const selectedModels = Array.isArray(plan.models)
    ? plan.models.map((model) => model?.name).filter(Boolean)
    : [];
  const hardware = plan.hardware || {};
  const memory = plan.memory || {};
  const recommendation = plan.recommendation || {};
  const risk = plan.risk || {};

  const lines = [
    "OLLAMA CAPACITY PLAN",
    `Hardware: ${hardware.backendName || hardware.backend || "unknown"}`,
    `Models: ${selectedModels.length > 0 ? selectedModels.join(", ") : "none selected"}`,
    "",
    "Recommended envelope:",
    `  Context: ${plan.envelope?.context?.recommended ?? "?"}`,
    `  Parallel: ${plan.envelope?.parallel?.recommended ?? "?"}`,
    `  Loaded models: ${plan.envelope?.loaded_models?.recommended ?? "?"}`,
    `  Estimated memory: ${memory.recommendedEstimatedGB ?? "?"}GB / ${memory.budgetGB ?? "?"}GB (${memory.utilizationPercent ?? "?"}%)`,
    `  Risk: ${(risk.level || "unknown").toUpperCase()} (${risk.score ?? "?"}/100)`,
  ];

  if (recommendation && Object.keys(recommendation).length > 0) {
    lines.push("");
    lines.push("Recommended env vars:");
    if (recommendation.num_ctx !== undefined) lines.push(`  export OLLAMA_NUM_CTX="${recommendation.num_ctx}"`);
    if (recommendation.num_parallel !== undefined) lines.push(`  export OLLAMA_NUM_PARALLEL="${recommendation.num_parallel}"`);
    if (recommendation.max_loaded_models !== undefined) lines.push(`  export OLLAMA_MAX_LOADED_MODELS="${recommendation.max_loaded_models}"`);
    if (recommendation.max_queue !== undefined) lines.push(`  export OLLAMA_MAX_QUEUE="${recommendation.max_queue}"`);
    if (recommendation.keep_alive !== undefined) lines.push(`  export OLLAMA_KEEP_ALIVE="${recommendation.keep_alive}"`);
    if (recommendation.flash_attention !== undefined) lines.push(`  export OLLAMA_FLASH_ATTENTION="${recommendation.flash_attention}"`);
  }

  return lines.join("\n");
}

const ALLOWED_CLI_COMMANDS = new Set([
  "policy",
  "audit",
  "calibrate",
  "check",
  "gpu-plan",
  "verify-context",
  "amd-guard",
  "toolcheck",
  "ollama",
  "installed",
  "ollama-plan",
  "recommend",
  "list-models",
  "ai-check",
  "ai-run",
  "demo",
  "sync",
  "search",
  "smart-recommend",
  "hw-detect",
]);

// ============================================================================
// MCP SERVER
// ============================================================================

const SERVER_VERSION = readPackageVersion();

const server = new McpServer({
  name: "llm-checker",
  version: SERVER_VERSION,
});

// ============================================================================
// CORE TOOLS (CLI wrappers)
// ============================================================================

server.tool(
  "hw_detect",
  "Detect hardware capabilities: CPU, GPU, RAM, acceleration backends, and recommended tier for running local LLMs",
  {},
  async () => {
    const result = await run(["hw-detect"]);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "check",
  "Full system analysis: detect hardware, scan Ollama catalog, and return all compatible models ranked by score with memory estimates",
  {},
  async () => {
    const result = await run(["check"], 180000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "recommend",
  "Get top model recommendations for a specific use case category, ranked by the 4D scoring engine (Quality, Speed, Fit, Context)",
  {
    category: z
      .enum(["general", "coding", "reasoning", "multimodal", "embedding", "small"])
      .optional()
      .describe("Use case category (omit for all categories)"),
  },
  async ({ category }) => {
    const args = ["recommend"];
    if (category) args.push(category);
    const result = await run(args, 180000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "installed",
  "List and rank all locally installed Ollama models by compatibility score against current hardware",
  {},
  async () => {
    const result = await run(["installed"], 60000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "search",
  "Search the Ollama model catalog by keyword. Requires sql.js.",
  {
    query: z.string().describe("Search keyword (model name, family, or capability)"),
    use_case: z
      .enum(["general", "coding", "chat", "reasoning", "creative", "fast"])
      .optional()
      .describe("Optimize results for a specific use case"),
    max_size: z.number().optional().describe("Maximum model size in GB"),
  },
  async ({ query, use_case, max_size }) => {
    const args = ["search", query];
    if (use_case) args.push("--use-case", use_case);
    if (max_size) args.push("--max-size", String(max_size));
    const result = await run(args, 60000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "smart_recommend",
  "Advanced recommendation using the full scoring engine with database integration. Requires sql.js.",
  {
    use_case: z
      .enum(["general", "coding", "chat", "reasoning", "creative", "fast", "quality"])
      .optional()
      .describe("Use case to optimize for"),
  },
  async ({ use_case }) => {
    const args = ["smart-recommend"];
    if (use_case) args.push("--use-case", use_case);
    const result = await run(args, 180000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "gpu_plan",
  "Multi-GPU placement advisor that returns safe single/pooled model-size envelopes and recommended Ollama env settings",
  {
    model_size: z.number().optional().describe("Optional target model size in GB to validate"),
  },
  async ({ model_size }) => {
    const args = ["gpu-plan"];
    if (model_size) args.push("--model-size", String(model_size));
    const result = await run(args, 60000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "verify_context",
  "Verify practical context-window limits for a local Ollama model using model metadata and hardware memory budget",
  {
    model: z.string().optional().describe("Model name to validate (default: first installed model)"),
    target_tokens: z.number().optional().describe("Target context window tokens (default: 8192)"),
  },
  async ({ model, target_tokens }) => {
    const args = ["verify-context"];
    if (model) args.push("--model", model);
    if (target_tokens) args.push("--target", String(target_tokens));
    const result = await run(args, 90000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "amd_guard",
  "Run AMD/Windows reliability guard checks and return mitigation hints for unstable GPU paths",
  {},
  async () => {
    const result = await run(["amd-guard"], 60000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "toolcheck",
  "Test tool-calling compatibility of local Ollama models and classify support as supported/partial/unsupported",
  {
    model: z.string().optional().describe("Optional model to test"),
    all: z.boolean().optional().describe("Test all installed models instead of only one"),
  },
  async ({ model, all }) => {
    const args = ["toolcheck"];
    if (model) args.push("--model", model);
    if (all) args.push("--all");
    const result = await run(args, 180000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "ollama_plan",
  "Build an Ollama capacity plan for selected local models and return recommended context/parallel/memory settings",
  {
    models: z
      .array(z.string())
      .optional()
      .describe("Optional list of model tags/families to include (default: all local models)"),
    ctx: z.number().int().positive().optional().describe("Target context window in tokens"),
    concurrency: z.number().int().positive().optional().describe("Target parallel request count"),
    objective: z
      .enum(["latency", "balanced", "throughput"])
      .optional()
      .describe("Optimization objective"),
    reserve_gb: z.number().min(0).optional().describe("Memory reserve in GB for OS/background workloads"),
  },
  async ({ models, ctx, concurrency, objective, reserve_gb }) => {
    const args = ["ollama-plan", "--json"];
    if (Array.isArray(models) && models.length > 0) args.push("--models", ...models);
    if (ctx !== undefined) args.push("--ctx", String(ctx));
    if (concurrency !== undefined) args.push("--concurrency", String(concurrency));
    if (objective) args.push("--objective", objective);
    if (reserve_gb !== undefined) args.push("--reserve-gb", String(reserve_gb));

    const result = await run(args, 180000);
    const payload = tryParseJSON(result);

    if (!payload) {
      return {
        content: [{ type: "text", text: result }],
      };
    }

    const summary = summarizeOllamaPlan(payload);
    const output = summary
      ? `${summary}\n\nRAW JSON:\n${JSON.stringify(payload, null, 2)}`
      : JSON.stringify(payload, null, 2);

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

server.tool(
  "ollama_plan_env",
  "Return shell export commands from an Ollama capacity plan (recommended or fallback profile)",
  {
    profile: z
      .enum(["recommended", "fallback"])
      .optional()
      .describe("Which profile to return (default: recommended)"),
    models: z
      .array(z.string())
      .optional()
      .describe("Optional list of model tags/families to include (default: all local models)"),
    ctx: z.number().int().positive().optional().describe("Target context window in tokens"),
    concurrency: z.number().int().positive().optional().describe("Target parallel request count"),
    objective: z
      .enum(["latency", "balanced", "throughput"])
      .optional()
      .describe("Optimization objective"),
    reserve_gb: z.number().min(0).optional().describe("Memory reserve in GB for OS/background workloads"),
  },
  async ({ profile, models, ctx, concurrency, objective, reserve_gb }) => {
    const args = ["ollama-plan", "--json"];
    if (Array.isArray(models) && models.length > 0) args.push("--models", ...models);
    if (ctx !== undefined) args.push("--ctx", String(ctx));
    if (concurrency !== undefined) args.push("--concurrency", String(concurrency));
    if (objective) args.push("--objective", objective);
    if (reserve_gb !== undefined) args.push("--reserve-gb", String(reserve_gb));

    const result = await run(args, 180000);
    const payload = tryParseJSON(result);
    if (!payload?.plan) {
      return {
        content: [{ type: "text", text: `Failed to parse ollama-plan output:\n${result}` }],
        isError: true,
      };
    }

    const selectedProfile = profile || "recommended";
    const plan = payload.plan;
    let envValues = null;

    if (selectedProfile === "fallback") {
      const fallback = plan.fallback || {};
      envValues = {
        OLLAMA_NUM_CTX: fallback.num_ctx,
        OLLAMA_NUM_PARALLEL: fallback.num_parallel,
        OLLAMA_MAX_LOADED_MODELS: fallback.max_loaded_models,
      };
    } else {
      envValues = plan.shell?.env || null;
      if (!envValues) {
        const recommendation = plan.recommendation || {};
        envValues = {
          OLLAMA_NUM_CTX: recommendation.num_ctx,
          OLLAMA_NUM_PARALLEL: recommendation.num_parallel,
          OLLAMA_MAX_LOADED_MODELS: recommendation.max_loaded_models,
          OLLAMA_MAX_QUEUE: recommendation.max_queue,
          OLLAMA_KEEP_ALIVE: recommendation.keep_alive,
          OLLAMA_FLASH_ATTENTION: recommendation.flash_attention,
        };
      }
    }

    const exports = formatExportBlock(envValues);
    if (!exports) {
      return {
        content: [{ type: "text", text: "No environment values available for this plan/profile." }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: [`PROFILE: ${selectedProfile.toUpperCase()}`, "", exports].join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "cli_help",
  "List all llm-checker CLI commands exposed via cli_exec",
  {},
  async () => {
    const commands = [...ALLOWED_CLI_COMMANDS].sort();
    const lines = [
      "Available commands for cli_exec:",
      ...commands.map((command) => `  - ${command}`),
      "",
      "Examples:",
      '  cli_exec command="ollama-plan" args=["--json"]',
      '  cli_exec command="policy" args=["validate","--file","policy.yaml","--json"]',
      '  cli_exec command="search" args=["qwen","--use-case","coding","--limit","5"]',
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "cli_exec",
  "Execute any supported llm-checker CLI command (allowlisted) with custom arguments",
  {
    command: z.string().describe("Top-level command (use cli_help to list allowed commands)"),
    args: z
      .array(z.string())
      .optional()
      .describe("Additional CLI args, exactly as used in terminal (without shell quoting)"),
    timeout_ms: z.number().int().min(1000).max(600000).optional().describe("Execution timeout in milliseconds"),
  },
  async ({ command, args, timeout_ms }) => {
    const trimmedCommand = String(command || "").trim();
    if (!ALLOWED_CLI_COMMANDS.has(trimmedCommand)) {
      return {
        content: [
          {
            type: "text",
            text: `Unsupported command "${trimmedCommand}". Use cli_help to list allowed commands.`,
          },
        ],
        isError: true,
      };
    }

    const safeArgs = Array.isArray(args) ? args : [];
    if (safeArgs.length > 100) {
      return {
        content: [{ type: "text", text: "Too many arguments. Limit is 100." }],
        isError: true,
      };
    }

    const result = await run([trimmedCommand, ...safeArgs], timeout_ms || 180000);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "policy_validate",
  "Validate a policy file against the v1 schema and return structured validation output",
  {
    file: z.string().optional().describe("Policy file path (default: policy.yaml)"),
  },
  async ({ file }) => {
    const args = ["policy", "validate", "--json"];
    if (file) args.push("--file", file);

    const result = await run(args, 120000);
    const payload = tryParseJSON(result);
    if (!payload) {
      return {
        content: [{ type: "text", text: result }],
      };
    }

    const status = payload.valid ? "VALID" : "INVALID";
    const header = [
      `POLICY VALIDATION: ${status}`,
      `File: ${payload.file || file || "policy.yaml"}`,
      `Errors: ${payload.errorCount ?? (Array.isArray(payload.errors) ? payload.errors.length : 0)}`,
    ].join("\n");

    return {
      content: [{ type: "text", text: `${header}\n\n${JSON.stringify(payload, null, 2)}` }],
      isError: !payload.valid,
    };
  }
);

server.tool(
  "audit_export",
  "Run policy compliance audit export (json/csv/sarif/all) for check/recommend flows",
  {
    policy: z.string().describe("Policy file path"),
    command: z
      .enum(["check", "recommend"])
      .optional()
      .describe("Evaluation source (default: check)"),
    format: z
      .enum(["json", "csv", "sarif", "all"])
      .optional()
      .describe("Export format (default: json)"),
    out: z.string().optional().describe("Output file path (single format only)"),
    out_dir: z.string().optional().describe("Output directory when --out is omitted"),
    use_case: z.string().optional().describe("Use case when command=check"),
    category: z.string().optional().describe("Category hint when command=recommend"),
    optimize: z
      .enum(["balanced", "speed", "quality", "context", "coding"])
      .optional()
      .describe("Optimization profile when command=recommend"),
    runtime: z
      .enum(["ollama", "vllm", "mlx"])
      .optional()
      .describe("Runtime backend for check mode"),
    include_cloud: z.boolean().optional().describe("Include cloud models in check-mode analysis"),
    max_size: z.string().optional().describe('Maximum model size for check mode (example: "24B" or "12GB")'),
    min_size: z.string().optional().describe('Minimum model size for check mode (example: "3B" or "2GB")'),
    limit: z.number().int().positive().optional().describe("Model analysis limit for check mode"),
    verbose: z.boolean().optional().describe("Enable verbose progress (default: true)"),
  },
  async ({
    policy,
    command,
    format,
    out,
    out_dir,
    use_case,
    category,
    optimize,
    runtime,
    include_cloud,
    max_size,
    min_size,
    limit,
    verbose,
  }) => {
    const args = ["audit", "export", "--policy", policy];
    if (command) args.push("--command", command);
    if (format) args.push("--format", format);
    if (out) args.push("--out", out);
    if (out_dir) args.push("--out-dir", out_dir);
    if (use_case) args.push("--use-case", use_case);
    if (category) args.push("--category", category);
    if (optimize) args.push("--optimize", optimize);
    if (runtime) args.push("--runtime", runtime);
    if (include_cloud) args.push("--include-cloud");
    if (max_size) args.push("--max-size", max_size);
    if (min_size) args.push("--min-size", min_size);
    if (limit !== undefined) args.push("--limit", String(limit));
    if (verbose === false) args.push("--no-verbose");

    const result = await run(args, 300000);
    const hadFailure =
      /audit export failed:/i.test(result) ||
      /blocking violations detected/i.test(result) ||
      /enforcement result:\s*blocking/i.test(result);
    return {
      content: [{ type: "text", text: result }],
      isError: hadFailure,
    };
  }
);

server.tool(
  "calibrate",
  "Generate calibration artifacts from a JSONL prompt suite (dry-run, contract-only, or full benchmark mode)",
  {
    suite: z.string().describe("Prompt suite path in JSONL format"),
    models: z.array(z.string()).describe("Model identifiers to include"),
    output: z.string().describe("Calibration result output path (.json/.yaml/.yml)"),
    runtime: z
      .enum(["ollama", "vllm", "mlx"])
      .optional()
      .describe("Inference runtime backend"),
    mode: z
      .enum(["dry-run", "contract-only", "full"])
      .optional()
      .describe("Execution mode"),
    objective: z
      .enum(["speed", "quality", "balanced"])
      .optional()
      .describe("Calibration objective"),
    policy_out: z.string().optional().describe("Optional calibration policy output path"),
    warmup: z.number().int().positive().optional().describe("Warmup runs per prompt in full mode"),
    iterations: z.number().int().positive().optional().describe("Measured iterations per prompt in full mode"),
    timeout_ms: z.number().int().positive().optional().describe("Per-prompt timeout in full mode (ms)"),
    dry_run: z.boolean().optional().describe("Shortcut flag for dry-run mode"),
  },
  async ({
    suite,
    models,
    output,
    runtime,
    mode,
    objective,
    policy_out,
    warmup,
    iterations,
    timeout_ms,
    dry_run,
  }) => {
    const args = ["calibrate", "--suite", suite, "--models", ...models, "--output", output];
    if (runtime) args.push("--runtime", runtime);
    if (mode) args.push("--mode", mode);
    if (objective) args.push("--objective", objective);
    if (policy_out) args.push("--policy-out", policy_out);
    if (warmup !== undefined) args.push("--warmup", String(warmup));
    if (iterations !== undefined) args.push("--iterations", String(iterations));
    if (timeout_ms !== undefined) args.push("--timeout-ms", String(timeout_ms));
    if (dry_run) args.push("--dry-run");

    const result = await run(args, 600000);
    const hadFailure = /calibration failed:/i.test(result);
    return {
      content: [{ type: "text", text: result }],
      isError: hadFailure,
    };
  }
);

// ============================================================================
// OLLAMA MANAGEMENT TOOLS
// ============================================================================

server.tool(
  "ollama_list",
  "List all models currently downloaded in Ollama with their sizes",
  {},
  async () => {
    try {
      const data = await ollamaAPI("/api/tags", null, 10000);
      if (!data.models || data.models.length === 0) {
        return { content: [{ type: "text", text: "No models installed." }] };
      }
      const lines = data.models.map((m) => {
        const size = formatBytes(m.size);
        const params = m.details?.parameter_size || "?";
        const quant = m.details?.quantization_level || "?";
        const family = m.details?.family || "?";
        return `${m.name.padEnd(30)} ${params.padEnd(8)} ${quant.padEnd(10)} ${family.padEnd(10)} ${size}`;
      });
      const header = `${"MODEL".padEnd(30)} ${"PARAMS".padEnd(8)} ${"QUANT".padEnd(10)} ${"FAMILY".padEnd(10)} SIZE`;
      return { content: [{ type: "text", text: [header, "-".repeat(80), ...lines].join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Ollama not available: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "ollama_pull",
  "Download/pull a model from the Ollama registry to local storage",
  { model: z.string().describe("Model name to pull (e.g. 'qwen2.5-coder:7b')") },
  async ({ model }) => {
    try {
      const { stdout } = await exec("ollama", ["pull", model], { timeout: 600000 });
      return { content: [{ type: "text", text: clean(stdout) || `Successfully pulled ${model}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to pull ${model}: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "ollama_run",
  "Run a prompt against a local Ollama model and return the response",
  {
    model: z.string().describe("Model name (e.g. 'qwen2.5-coder:7b')"),
    prompt: z.string().describe("The prompt to send to the model"),
  },
  async ({ model, prompt }) => {
    try {
      const data = await ollamaAPI("/api/generate", { model, prompt, stream: false }, 300000);
      const tokPerSec = formatTokPerSec(tokensPerSecond(data.eval_count, data.eval_duration));
      const result = [
        `MODEL: ${model}`,
        `RESPONSE: ${data.response}`,
        `---`,
        `Tokens generated: ${data.eval_count || "?"}`,
        `Speed: ${tokPerSec} tok/s`,
        `Total time: ${data.total_duration ? nsToSec(data.total_duration) + "s" : "?"}`,
        `Load time: ${data.load_duration ? nsToMs(data.load_duration) + "ms" : "?"}`,
      ].join("\n");
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to run ${model}: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "ollama_remove",
  "Remove/delete a model from local Ollama storage to free disk space",
  { model: z.string().describe("Model name to remove (e.g. 'llama3.2:1b')") },
  async ({ model }) => {
    try {
      await ollamaAPI("/api/delete", { name: model }, 30000);
      return { content: [{ type: "text", text: `Removed ${model}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to remove ${model}: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// ADVANCED TOOL 1: Auto-Optimize Ollama Config
// ============================================================================

server.tool(
  "ollama_optimize",
  "Analyze hardware and generate optimal Ollama environment variables (OLLAMA_NUM_GPU, OLLAMA_NUM_PARALLEL, OLLAMA_MAX_LOADED_MODELS, OLLAMA_FLASH_ATTENTION, etc.) for peak performance",
  {},
  async () => {
    try {
      // M1: source hardware facts from structured `hw-detect --json` instead of
      // regex-scraping human-readable CLI text.
      const hwJsonText = await run(["hw-detect", "--json"]);
      const hwJson = tryParseJSON(hwJsonText);
      const { tier, vramGB } = mapHardwareJson(hwJson || {});

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const cpuCount = os.cpus().length;
      const totalGB = Math.round(totalMem / 1e9);
      const freeGB = Math.round(freeMem / 1e9);
      const platform = os.platform();

      // Determine GPU layers
      const isApple = platform === "darwin";
      let numGPU = 999; // Apple Silicon = all layers on GPU
      if (!isApple) {
        // For discrete GPUs, estimate based on tier
        if (tier.includes("HIGH") || tier.includes("ULTRA")) numGPU = 999;
        else if (tier.includes("MEDIUM")) numGPU = 35;
        else numGPU = 20;
      }

      // Parallel requests based on RAM
      let numParallel = 1;
      if (totalGB >= 64) numParallel = 4;
      else if (totalGB >= 32) numParallel = 3;
      else if (totalGB >= 16) numParallel = 2;

      // Max loaded models
      let maxLoaded = 1;
      if (totalGB >= 64) maxLoaded = 3;
      else if (totalGB >= 32) maxLoaded = 2;

      // Context size recommendation
      let ctxSize = 4096;
      if (totalGB >= 64) ctxSize = 16384;
      else if (totalGB >= 32) ctxSize = 8192;

      // Flash attention (supported on Apple Silicon and modern CUDA)
      const flashAttn = isApple || tier.includes("HIGH") || tier.includes("ULTRA") ? "1" : "0";

      // Keep alive
      let keepAlive = "5m";
      if (totalGB >= 32) keepAlive = "15m";
      if (totalGB >= 64) keepAlive = "30m";

      const envVars = {
        OLLAMA_NUM_GPU: String(numGPU),
        OLLAMA_NUM_PARALLEL: String(numParallel),
        OLLAMA_MAX_LOADED_MODELS: String(maxLoaded),
        OLLAMA_FLASH_ATTENTION: flashAttn,
        OLLAMA_KEEP_ALIVE: keepAlive,
        OLLAMA_NUM_CTX: String(ctxSize),
      };

      // Shell export commands
      const exportLines = Object.entries(envVars)
        .map(([k, v]) => `export ${k}="${v}"`)
        .join("\n");

      // Launchd plist snippet for macOS
      const plistSnippet = Object.entries(envVars)
        .map(([k, v]) => `        <key>${k}</key>\n        <string>${v}</string>`)
        .join("\n");

      const output = [
        `OLLAMA OPTIMIZATION FOR YOUR SYSTEM`,
        `====================================`,
        `Hardware: ${cpuCount} cores, ${totalGB}GB total RAM, ${freeGB}GB free`,
        `Platform: ${platform} | Tier: ${tier}${vramGB !== null ? ` | VRAM: ${vramGB}GB` : ""}`,
        ``,
        `RECOMMENDED ENVIRONMENT VARIABLES:`,
        `----------------------------------`,
        ...Object.entries(envVars).map(([k, v]) => {
          const desc = {
            OLLAMA_NUM_GPU: "GPU layers (999 = all layers offloaded to GPU)",
            OLLAMA_NUM_PARALLEL: "Concurrent request slots",
            OLLAMA_MAX_LOADED_MODELS: "Models kept in memory simultaneously",
            OLLAMA_FLASH_ATTENTION: "Flash attention for faster inference",
            OLLAMA_KEEP_ALIVE: "Time to keep model loaded after last request",
            OLLAMA_NUM_CTX: "Default context window size (tokens)",
          };
          return `  ${k}=${v}  # ${desc[k]}`;
        }),
        ``,
        `SHELL (add to ~/.zshrc or ~/.bashrc):`,
        `--------------------------------------`,
        exportLines,
        ``,
        `MACOS LAUNCHD (add to Ollama plist EnvironmentVariables):`,
        `--------------------------------------------------------`,
        plistSnippet,
      ].join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Optimization failed: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// ADVANCED TOOL 2: Benchmark Model
// ============================================================================

server.tool(
  "benchmark",
  "Benchmark a local Ollama model: measure tokens/sec, load time, and generation speed. With no custom prompt it runs the SAME standardized prompt 3 times (true warm-up iterations); the first (cold) run is excluded from the tok/s average and load time is reported from that first run. A custom prompt is run once.",
  {
    model: z.string().describe("Model name to benchmark (e.g. 'qwen2.5-coder:7b')"),
    prompt: z
      .string()
      .optional()
      .describe("Custom benchmark prompt (default: standardized coding prompt run 3x)"),
  },
  async ({ model, prompt }) => {
    // M4: when no custom prompt is given, run the SAME prompt N times so these
    // are real iterations of one workload (warm-up effects, not different
    // tasks). The first run is cold (includes model load) and is excluded from
    // the tok/s average; its load time is reported separately.
    const STANDARD_PROMPT =
      "Write a Python function to find the nth Fibonacci number using memoization. Include type hints.";
    const usingCustom = Boolean(prompt);
    const benchPrompt = usingCustom ? prompt : STANDARD_PROMPT;
    const iterations = usingCustom ? 1 : 3;

    try {
      const results = [];
      for (let i = 0; i < iterations; i++) {
        const data = await ollamaAPI(
          "/api/generate",
          { model, prompt: benchPrompt, stream: false },
          300000
        );

        const evalTokens = data.eval_count || 0;
        // M2: only a finite value when both eval_count and eval_duration are > 0.
        const tokPerSec = tokensPerSecond(data.eval_count, data.eval_duration);
        const totalSec = data.total_duration ? data.total_duration / 1e9 : 0;
        const loadMs = data.load_duration ? data.load_duration / 1e6 : 0;
        const promptTokens = data.prompt_eval_count || 0;
        const promptMs = data.prompt_eval_duration ? data.prompt_eval_duration / 1e6 : 0;

        results.push({
          evalTokens,
          tokPerSec,
          totalSec,
          loadMs,
          promptTokens,
          promptMs,
          responsePreview: (data.response || "").slice(0, 100),
        });
      }

      // tok/s average over WARM runs only (exclude the cold first run when we
      // have more than one iteration). Drop unavailable (null) measurements.
      const warmRuns = iterations > 1 ? results.slice(1) : results;
      const warmTokRates = warmRuns.map((r) => r.tokPerSec).filter((v) => v !== null);
      const avgTokPerSec = warmTokRates.length > 0
        ? warmTokRates.reduce((s, v) => s + v, 0) / warmTokRates.length
        : null;

      const warmTotals = warmRuns.map((r) => r.totalSec);
      const avgTotalSec = warmTotals.reduce((s, v) => s + v, 0) / warmTotals.length;
      // Load time is a cold-start cost: report it from the first run only.
      const coldLoadMs = results[0]?.loadMs ?? 0;
      const totalTokens = results.reduce((s, r) => s + r.evalTokens, 0);

      const promptPreview = benchPrompt.slice(0, 60) + (benchPrompt.length > 60 ? "..." : "");

      const output = [
        `BENCHMARK: ${model}`,
        `${"=".repeat(60)}`,
        `Prompt: "${promptPreview}"`,
        `Iterations: ${results.length}${iterations > 1 ? " (run 1 = cold, excluded from speed average)" : ""}`,
        ``,
        ...results.map((r, i) => [
          `--- Run ${i + 1}${iterations > 1 && i === 0 ? " (cold)" : ""} ---`,
          `Generated: ${r.evalTokens} tokens at ${formatTokPerSec(r.tokPerSec)} tok/s`,
          `Total: ${r.totalSec.toFixed(2)}s | Load: ${r.loadMs.toFixed(0)}ms | Prompt eval: ${r.promptMs.toFixed(0)}ms (${r.promptTokens} tokens)`,
          `Response: "${r.responsePreview}..."`,
          ``,
        ]).flat(),
        `${"=".repeat(60)}`,
        iterations > 1 ? `WARM AVERAGES (excludes cold run 1):` : `RESULTS:`,
        `  Generation speed: ${formatTokPerSec(avgTokPerSec)} tok/s`,
        `  Total time: ${avgTotalSec.toFixed(2)}s`,
        `  Cold load time: ${coldLoadMs.toFixed(0)}ms`,
        `  Total tokens generated: ${totalTokens}`,
      ].join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Benchmark failed: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// ADVANCED TOOL 3: Compare Models Head-to-Head
// ============================================================================

server.tool(
  "compare_models",
  "Compare two local Ollama models head-to-head on the same prompt. Models are run SEQUENTIALLY (model A fully, then model B) so each tok/s measurement is uncontended — running them in parallel would make them fight over GPU/RAM and invalidate the speed comparison.",
  {
    model_a: z.string().describe("First model (e.g. 'qwen2.5-coder:7b')"),
    model_b: z.string().describe("Second model (e.g. 'codellama:7b')"),
    prompt: z
      .string()
      .optional()
      .describe("Prompt to test both models (default: coding challenge)"),
  },
  async ({ model_a, model_b, prompt }) => {
    const testPrompt = prompt || "Write a Python function that checks if a string is a valid IPv4 address. Include edge cases.";

    try {
      // M3: run sequentially so the two models do not contend for GPU/RAM.
      // Each measurement is taken while the other model is not executing.
      const resultA = await ollamaAPI("/api/generate", { model: model_a, prompt: testPrompt, stream: false }, 300000);
      const resultB = await ollamaAPI("/api/generate", { model: model_b, prompt: testPrompt, stream: false }, 300000);

      function metrics(data) {
        const evalTokens = data.eval_count || 0;
        // M2: null when eval_count/eval_duration are not both positive.
        const tokPerSec = tokensPerSecond(data.eval_count, data.eval_duration);
        const totalSec = data.total_duration ? data.total_duration / 1e9 : 0;
        const loadSec = data.load_duration ? data.load_duration / 1e9 : 0;
        return { evalTokens, tokPerSec, totalSec, loadSec, response: data.response || "" };
      }

      const a = metrics(resultA);
      const b = metrics(resultB);

      // Only declare a speed winner when both rates are known.
      let speedWinner;
      if (a.tokPerSec === null && b.tokPerSec === null) speedWinner = "n/a (no timing data)";
      else if (a.tokPerSec === null) speedWinner = model_b;
      else if (b.tokPerSec === null) speedWinner = model_a;
      else speedWinner = a.tokPerSec >= b.tokPerSec ? model_a : model_b;

      const verbosityWinner = a.evalTokens >= b.evalTokens ? model_a : model_b;

      const output = [
        `HEAD-TO-HEAD COMPARISON (sequential runs, uncontended)`,
        `${"=".repeat(70)}`,
        `Prompt: "${testPrompt.slice(0, 80)}${testPrompt.length > 80 ? "..." : ""}"`,
        ``,
        `METRIC                  ${model_a.padEnd(25)} ${model_b.padEnd(25)}`,
        `-`.repeat(70),
        `Speed (tok/s)           ${formatTokPerSec(a.tokPerSec).padEnd(25)} ${formatTokPerSec(b.tokPerSec).padEnd(25)}`,
        `Tokens generated        ${String(a.evalTokens).padEnd(25)} ${String(b.evalTokens).padEnd(25)}`,
        `Total time              ${(a.totalSec.toFixed(2) + "s").padEnd(25)} ${(b.totalSec.toFixed(2) + "s").padEnd(25)}`,
        `Load time               ${(a.loadSec.toFixed(2) + "s").padEnd(25)} ${(b.loadSec.toFixed(2) + "s").padEnd(25)}`,
        ``,
        `WINNER (speed): ${speedWinner}`,
        `MORE DETAILED: ${verbosityWinner} (${Math.max(a.evalTokens, b.evalTokens)} tokens)`,
        ``,
        `----- ${model_a} RESPONSE -----`,
        a.response.slice(0, 500),
        ``,
        `----- ${model_b} RESPONSE -----`,
        b.response.slice(0, 500),
      ].join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Comparison failed: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// ADVANCED TOOL 4: Smart Model Cleanup
// ============================================================================

server.tool(
  "cleanup_models",
  "Analyze installed Ollama models and recommend which to keep, remove, or upgrade. Shows disk usage, redundancies, and better alternatives for each model.",
  {},
  async () => {
    try {
      const [tagsData, hwJsonText] = await Promise.all([
        ollamaAPI("/api/tags", null, 10000),
        run(["hw-detect", "--json"]),
      ]);

      if (!tagsData.models || tagsData.models.length === 0) {
        return { content: [{ type: "text", text: "No models installed." }] };
      }

      const models = tagsData.models;
      const totalSize = models.reduce((s, m) => s + (m.size || 0), 0);

      // M1: source hardware tier + max model size from structured JSON instead
      // of regex-scraping CLI text. mapHardwareJson() falls back to a sane 15GB
      // default if the JSON could not be parsed (tryParseJSON -> null).
      const { maxGB } = mapHardwareJson(tryParseJSON(hwJsonText) || {});

      // Analyze each model
      const analysis = models.map((m) => {
        const sizeGB = m.size / 1e9;
        const params = m.details?.parameter_size || "?";
        const quant = m.details?.quantization_level || "?";
        const family = m.details?.family || "?";

        // Cloud models (0 size) - flag as not locally useful
        if (sizeGB < 0.01) {
          return { name: m.name, action: "REMOVE", reason: "Cloud-only model (0 bytes), not a local model", sizeGB, params, quant, family };
        }

        // Too large for hardware
        if (sizeGB > maxGB) {
          return { name: m.name, action: "REMOVE", reason: `Too large (${sizeGB.toFixed(1)}GB) for your ${maxGB}GB max`, sizeGB, params, quant, family };
        }

        // Low quantization that could be upgraded
        if (quant === "Q2_K" || quant === "Q3_K_S") {
          return { name: m.name, action: "UPGRADE", reason: `Low quant (${quant}) — consider Q4_K_M for better quality`, sizeGB, params, quant, family };
        }

        return { name: m.name, action: "KEEP", reason: "Good fit for your hardware", sizeGB, params, quant, family };
      });

      // Detect redundant models (same family, different sizes)
      const familyGroups = {};
      for (const a of analysis) {
        const key = a.family;
        if (!familyGroups[key]) familyGroups[key] = [];
        familyGroups[key].push(a);
      }
      for (const [family, group] of Object.entries(familyGroups)) {
        if (group.length > 1) {
          // Sort by size, mark smaller ones as potentially redundant
          group.sort((a, b) => b.sizeGB - a.sizeGB);
          for (let i = 1; i < group.length; i++) {
            if (group[i].action === "KEEP") {
              group[i].action = "REVIEW";
              group[i].reason = `Redundant — you have ${group[0].name} (${group[0].params}) in the same family`;
            }
          }
        }
      }

      const removeModels = analysis.filter((a) => a.action === "REMOVE");
      const reclaimable = removeModels.reduce((s, a) => s + a.sizeGB, 0);

      const output = [
        `MODEL CLEANUP ANALYSIS`,
        `${"=".repeat(70)}`,
        `Installed: ${models.length} models | Total: ${formatBytes(totalSize)} | Hardware max: ${maxGB}GB`,
        ``,
        ...analysis.map((a) => {
          const icon = { KEEP: "[KEEP]", REMOVE: "[REMOVE]", UPGRADE: "[UPGRADE]", REVIEW: "[REVIEW]" }[a.action];
          return `${icon.padEnd(10)} ${a.name.padEnd(30)} ${a.params.padEnd(8)} ${a.quant.padEnd(10)} ${a.sizeGB.toFixed(1)}GB\n           ${a.reason}`;
        }),
        ``,
        `SUMMARY:`,
        `  Keep: ${analysis.filter((a) => a.action === "KEEP").length}`,
        `  Remove: ${removeModels.length}${reclaimable > 0 ? ` (reclaim ${reclaimable.toFixed(1)}GB)` : ""}`,
        `  Upgrade: ${analysis.filter((a) => a.action === "UPGRADE").length}`,
        `  Review: ${analysis.filter((a) => a.action === "REVIEW").length}`,
        ``,
        removeModels.length > 0
          ? `TO REMOVE:\n${removeModels.map((m) => `  ollama rm ${m.name}`).join("\n")}`
          : `All models look good!`,
      ].join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Cleanup analysis failed: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// ADVANCED TOOL 5: Project-Aware Recommendations
// ============================================================================

server.tool(
  "project_recommend",
  "Scan a project directory to detect languages, frameworks, and size, then recommend the best local Ollama model for working with that specific codebase",
  {
    path: z.string().describe("Absolute path to the project directory"),
  },
  async ({ path: projectPath }) => {
    try {
      // Scan the project
      const langCounts = {};
      const frameworks = new Set();
      let totalFiles = 0;
      let totalLines = 0;

      const extMap = {
        ".js": "JavaScript", ".mjs": "JavaScript", ".jsx": "JavaScript",
        ".ts": "TypeScript", ".tsx": "TypeScript",
        ".py": "Python", ".pyi": "Python",
        ".rs": "Rust",
        ".go": "Go",
        ".java": "Java", ".kt": "Kotlin",
        ".c": "C", ".h": "C", ".cpp": "C++", ".hpp": "C++",
        ".rb": "Ruby",
        ".php": "PHP",
        ".swift": "Swift",
        ".sol": "Solidity",
        ".cs": "C#",
        ".lua": "Lua",
        ".zig": "Zig",
        ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
      };

      async function scanDir(dir, depth = 0) {
        if (depth > 4) return; // Max depth
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            // M7: detect known framework markers (incl. dot-directories like
            // ".github" -> "GitHub Actions") BEFORE skipping dotfiles, otherwise
            // the dotfile skip below means ".github" can never be matched.
            const marker = detectFrameworkMarker(entry.name);
            if (marker) frameworks.add(marker);

            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target" || entry.name === "__pycache__" || entry.name === "dist" || entry.name === "build" || entry.name === "vendor") continue;

            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              await scanDir(fullPath, depth + 1);
            } else {
              // Count by extension
              const ext = entry.name.includes(".") ? "." + entry.name.split(".").pop().toLowerCase() : "";
              if (extMap[ext]) {
                langCounts[extMap[ext]] = (langCounts[extMap[ext]] || 0) + 1;
                totalFiles++;
              }

              // Estimate lines (rough)
              try {
                const s = await stat(fullPath);
                if (s.size < 500000) { // skip large files
                  totalLines += Math.round(s.size / 40); // ~40 bytes per line estimate
                }
              } catch {}
            }
          }
        } catch {}
      }

      await scanDir(projectPath);

      // Determine primary language
      const sortedLangs = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
      const primaryLang = sortedLangs[0]?.[0] || "Unknown";

      // Determine project size
      let projectSize = "small";
      if (totalLines > 50000) projectSize = "large";
      else if (totalLines > 10000) projectSize = "medium";

      // Determine best use case
      let useCase = "coding";
      let contextNeeded = 4096;
      if (projectSize === "large") contextNeeded = 16384;
      else if (projectSize === "medium") contextNeeded = 8192;

      // Get model recommendation
      const recResult = await run(["recommend", "coding"], 180000);

      const output = [
        `PROJECT ANALYSIS: ${projectPath}`,
        `${"=".repeat(70)}`,
        ``,
        `LANGUAGES:`,
        ...sortedLangs.slice(0, 8).map(([lang, count]) => `  ${lang.padEnd(15)} ${count} files`),
        ``,
        `FRAMEWORKS: ${[...frameworks].join(", ") || "None detected"}`,
        `PRIMARY: ${primaryLang}`,
        `SIZE: ${projectSize} (~${totalFiles} source files, ~${totalLines.toLocaleString()} lines)`,
        `RECOMMENDED CONTEXT: ${contextNeeded} tokens`,
        ``,
        `MODEL RECOMMENDATION FOR THIS PROJECT:`,
        `${"=".repeat(70)}`,
        recResult,
        ``,
        `TIPS:`,
        `  - For ${primaryLang} projects, coding-optimized models perform best`,
        contextNeeded > 8192 ? `  - Large codebase: prefer models with 16K+ context (set OLLAMA_NUM_CTX=${contextNeeded})` : "",
        sortedLangs.length > 3 ? `  - Polyglot project: general coding models (qwen2.5-coder, deepseek-coder) handle multiple languages well` : "",
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Project analysis failed: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// ADVANCED TOOL 6: Real-Time Ollama Monitor
// ============================================================================

server.tool(
  "ollama_monitor",
  "Show real-time Ollama status: running models, VRAM/RAM usage, active requests, and system resource utilization",
  {},
  async () => {
    try {
      const [psData, tagsData] = await Promise.all([
        ollamaAPI("/api/ps", null, 10000),
        ollamaAPI("/api/tags", null, 10000),
      ]);

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPercent = ((usedMem / totalMem) * 100).toFixed(1);
      const cpus = os.cpus();
      const loadAvg = os.loadavg();

      // M5: os.loadavg() is always [0,0,0] on Windows, so deriving CPU% from it
      // reports a misleading 0%. Detect that case (Windows, or an all-zero
      // loadavg) and show "n/a" instead.
      const loadAvgUnavailable =
        os.platform() === "win32" || (loadAvg[0] === 0 && loadAvg[1] === 0 && loadAvg[2] === 0);
      const cpuPercentLabel = loadAvgUnavailable
        ? "n/a (load average not reported on this platform)"
        : `${((loadAvg[0] / cpus.length) * 100).toFixed(1)}% (load: ${loadAvg[0].toFixed(2)})`;

      // Installed models total size
      const installedModels = tagsData.models || [];
      const totalModelSize = installedModels.reduce((s, m) => s + (m.size || 0), 0);

      // Running models
      const runningModels = psData.models || [];

      const lines = [
        `OLLAMA MONITOR`,
        `${"=".repeat(60)}`,
        ``,
        `SYSTEM RESOURCES:`,
        `  System RAM: ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}% used)`,
        `  Free: ${formatBytes(freeMem)}`,
        `  CPU: ${cpuPercentLabel} (${cpus.length} cores)`,
        ``,
        `OLLAMA STATUS:`,
        `  Installed models: ${installedModels.length} (${formatBytes(totalModelSize)} on disk)`,
        `  Running models: ${runningModels.length}`,
      ];

      // M5: surface each running model's VRAM residency from /api/ps.
      let anyOnGpu = false;
      if (runningModels.length > 0) {
        lines.push(``, `  LOADED IN MEMORY:`);
        for (const m of runningModels) {
          const sizeVram = Number(m.size_vram) || 0;
          const totalLoaded = Number(m.size) || 0;
          if (sizeVram > 0) anyOnGpu = true;
          const vram = sizeVram > 0 ? formatBytes(sizeVram) : "0 B";
          const total = totalLoaded > 0 ? formatBytes(totalLoaded) : "?";
          // Portion resident in system RAM (CPU offload) = total - VRAM.
          const ramPortion = totalLoaded > sizeVram ? formatBytes(totalLoaded - sizeVram) : "0 B";
          const expires = m.expires_at ? new Date(m.expires_at).toLocaleTimeString() : "?";
          lines.push(
            `    ${m.name.padEnd(25)} total ${total.padEnd(10)} VRAM ${vram.padEnd(10)} sysRAM ${ramPortion.padEnd(10)} Expires: ${expires}`
          );
        }
      } else {
        lines.push(``, `  No models currently loaded in memory.`);
      }

      // M5: the system-RAM free figure is NOT the constraint on GPU boxes —
      // model residency is bounded by VRAM there. Clarify that this headroom
      // note reflects system RAM, and call out that VRAM is the real limit when
      // models are running on the GPU.
      const freeGB = freeMem / 1e9;
      lines.push(
        ``,
        `MEMORY HEADROOM (system RAM):`,
        `  Free system RAM: ~${freeGB.toFixed(1)}GB`,
        freeGB > 12
          ? `  Status: PLENTY — can load 14B+ models comfortably (system-RAM view)`
          : freeGB > 6
          ? `  Status: OK — can load 7B models, 14B might be tight (system-RAM view)`
          : freeGB > 3
          ? `  Status: LOW — stick to 3B-7B models (system-RAM view)`
          : `  Status: CRITICAL — close other apps before running models (system-RAM view)`,
        anyOnGpu
          ? `  NOTE: models are loaded into VRAM on this box — GPU VRAM (see per-model VRAM above), not system RAM, is the real loading constraint.`
          : `  NOTE: on dedicated-GPU systems, GPU VRAM (not system RAM) is the real constraint for loading models.`
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Monitor failed: ${err.message}` }], isError: true };
    }
  }
);

// ============================================================================
// START
// ============================================================================

// Connect the stdio transport and start serving. Guarded behind main() so that
// importing this module (e.g. from tests) does NOT start the server — only
// running the file directly does.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Detect whether this module is the process entry point. When invoked as
// `node bin/mcp-server.mjs`, process.argv[1] resolves to this file's path; when
// merely imported (e.g. from a test), it points at the importer instead, so the
// server is not started. fileURLToPath(import.meta.url) gives this file's
// absolute path; argv[1] is the absolute path Node was launched with. We also
// resolve argv[1] through fileURLToPath when it is a file:// URL.
function runningAsEntry() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const thisPath = fileURLToPath(import.meta.url);
    const entryPath = entry.startsWith("file://") ? fileURLToPath(entry) : entry;
    return entryPath === thisPath;
  } catch {
    return false;
  }
}

if (runningAsEntry()) {
  await main();
}

// Exported for unit testing. Importing this module must NOT start the server
// (see runningAsEntry guard above).
export {
  SERVER_VERSION,
  readPackageVersion,
  tokensPerSecond,
  formatTokPerSec,
  mapHardwareJson,
  detectFrameworkMarker,
  FRAMEWORK_MARKERS,
};
