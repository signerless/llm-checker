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
import http from "http";
import os from "os";

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = join(__dirname, "enhanced_cli.js");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

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
    if (err.stdout) return clean(err.stdout);
    throw new Error(`llm-checker failed: ${err.message}`);
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

const server = new McpServer({
  name: "llm-checker",
  version: "3.4.0",
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
      const tokPerSec = data.eval_count && data.eval_duration
        ? ((data.eval_count / data.eval_duration) * 1e9).toFixed(1)
        : "?";
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
      const hwResult = await run(["hw-detect"]);
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const cpuCount = os.cpus().length;
      const totalGB = Math.round(totalMem / 1e9);
      const freeGB = Math.round(freeMem / 1e9);
      const platform = os.platform();

      // Parse tier from hw-detect output
      const tierMatch = hwResult.match(/Tier:\s*(\w[\w\s]*)/i);
      const tier = tierMatch ? tierMatch[1].trim().toUpperCase() : "UNKNOWN";

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
        `Platform: ${platform} | Tier: ${tier}`,
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
  "Benchmark a local Ollama model: measure tokens/sec, load time, and generation speed with a standardized prompt or custom prompt. Runs 3 iterations for reliable averages.",
  {
    model: z.string().describe("Model name to benchmark (e.g. 'qwen2.5-coder:7b')"),
    prompt: z
      .string()
      .optional()
      .describe("Custom benchmark prompt (default: standardized coding + reasoning prompt)"),
  },
  async ({ model, prompt }) => {
    const benchPrompts = prompt
      ? [prompt]
      : [
          "Write a Python function to find the nth Fibonacci number using memoization. Include type hints.",
          "Explain the difference between a mutex and a semaphore in 3 sentences.",
          "What is the time complexity of quicksort in the average and worst case? Answer briefly.",
        ];

    try {
      const results = [];
      for (let i = 0; i < benchPrompts.length; i++) {
        const data = await ollamaAPI(
          "/api/generate",
          { model, prompt: benchPrompts[i], stream: false },
          300000
        );

        const evalTokens = data.eval_count || 0;
        const evalDur = data.eval_duration || 1;
        const tokPerSec = (evalTokens / evalDur) * 1e9;
        const totalSec = data.total_duration ? data.total_duration / 1e9 : 0;
        const loadMs = data.load_duration ? data.load_duration / 1e6 : 0;
        const promptTokens = data.prompt_eval_count || 0;
        const promptMs = data.prompt_eval_duration ? data.prompt_eval_duration / 1e6 : 0;

        results.push({
          prompt: benchPrompts[i].slice(0, 60) + (benchPrompts[i].length > 60 ? "..." : ""),
          evalTokens,
          tokPerSec,
          totalSec,
          loadMs,
          promptTokens,
          promptMs,
          responsePreview: (data.response || "").slice(0, 100),
        });
      }

      // Compute averages
      const avgTokPerSec = results.reduce((s, r) => s + r.tokPerSec, 0) / results.length;
      const avgTotalSec = results.reduce((s, r) => s + r.totalSec, 0) / results.length;
      const avgLoadMs = results.reduce((s, r) => s + r.loadMs, 0) / results.length;
      const totalTokens = results.reduce((s, r) => s + r.evalTokens, 0);

      const output = [
        `BENCHMARK: ${model}`,
        `${"=".repeat(60)}`,
        `Iterations: ${results.length}`,
        ``,
        ...results.map((r, i) => [
          `--- Run ${i + 1} ---`,
          `Prompt: "${r.prompt}"`,
          `Generated: ${r.evalTokens} tokens at ${r.tokPerSec.toFixed(1)} tok/s`,
          `Total: ${r.totalSec.toFixed(2)}s | Load: ${r.loadMs.toFixed(0)}ms | Prompt eval: ${r.promptMs.toFixed(0)}ms (${r.promptTokens} tokens)`,
          `Response: "${r.responsePreview}..."`,
          ``,
        ]).flat(),
        `${"=".repeat(60)}`,
        `AVERAGES:`,
        `  Generation speed: ${avgTokPerSec.toFixed(1)} tok/s`,
        `  Total time: ${avgTotalSec.toFixed(2)}s`,
        `  Load time: ${avgLoadMs.toFixed(0)}ms`,
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
  "Compare two local Ollama models head-to-head: same prompt, measured speed, token count, and response quality side by side",
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
      // Run both models
      const [resultA, resultB] = await Promise.all([
        ollamaAPI("/api/generate", { model: model_a, prompt: testPrompt, stream: false }, 300000),
        ollamaAPI("/api/generate", { model: model_b, prompt: testPrompt, stream: false }, 300000),
      ]);

      function metrics(data) {
        const evalTokens = data.eval_count || 0;
        const evalDur = data.eval_duration || 1;
        const tokPerSec = (evalTokens / evalDur) * 1e9;
        const totalSec = data.total_duration ? data.total_duration / 1e9 : 0;
        const loadSec = data.load_duration ? data.load_duration / 1e9 : 0;
        return { evalTokens, tokPerSec, totalSec, loadSec, response: data.response || "" };
      }

      const a = metrics(resultA);
      const b = metrics(resultB);

      const speedWinner = a.tokPerSec > b.tokPerSec ? model_a : model_b;
      const verbosityWinner = a.evalTokens > b.evalTokens ? model_a : model_b;

      const output = [
        `HEAD-TO-HEAD COMPARISON`,
        `${"=".repeat(70)}`,
        `Prompt: "${testPrompt.slice(0, 80)}${testPrompt.length > 80 ? "..." : ""}"`,
        ``,
        `METRIC                  ${model_a.padEnd(25)} ${model_b.padEnd(25)}`,
        `-`.repeat(70),
        `Speed (tok/s)           ${a.tokPerSec.toFixed(1).padEnd(25)} ${b.tokPerSec.toFixed(1).padEnd(25)}`,
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
      const [tagsData, hwResult] = await Promise.all([
        ollamaAPI("/api/tags", null, 10000),
        run(["hw-detect"]),
      ]);

      if (!tagsData.models || tagsData.models.length === 0) {
        return { content: [{ type: "text", text: "No models installed." }] };
      }

      const models = tagsData.models;
      const totalSize = models.reduce((s, m) => s + (m.size || 0), 0);

      // Parse hardware tier
      const tierMatch = hwResult.match(/Tier:\s*(\w[\w\s]*)/i);
      const tier = tierMatch ? tierMatch[1].trim() : "UNKNOWN";
      const maxSizeMatch = hwResult.match(/Max model size:\s*(\d+)/i);
      const maxGB = maxSizeMatch ? parseInt(maxSizeMatch[1]) : 15;

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

      const frameworkFiles = {
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

      async function scanDir(dir, depth = 0) {
        if (depth > 4) return; // Max depth
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "target" || entry.name === "__pycache__" || entry.name === "dist" || entry.name === "build" || entry.name === "vendor") continue;

            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (frameworkFiles[entry.name]) frameworks.add(frameworkFiles[entry.name]);
              await scanDir(fullPath, depth + 1);
            } else {
              // Check framework files
              if (frameworkFiles[entry.name]) frameworks.add(frameworkFiles[entry.name]);

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

      // CPU usage from loadavg
      const cpuPercent = ((loadAvg[0] / cpus.length) * 100).toFixed(1);

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
        `  RAM: ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}% used)`,
        `  Free: ${formatBytes(freeMem)}`,
        `  CPU: ${cpuPercent}% (${cpus.length} cores, load: ${loadAvg[0].toFixed(2)})`,
        ``,
        `OLLAMA STATUS:`,
        `  Installed models: ${installedModels.length} (${formatBytes(totalModelSize)} on disk)`,
        `  Running models: ${runningModels.length}`,
      ];

      if (runningModels.length > 0) {
        lines.push(``, `  LOADED IN MEMORY:`);
        for (const m of runningModels) {
          const vram = m.size_vram ? formatBytes(m.size_vram) : "?";
          const ram = m.size ? formatBytes(m.size) : "?";
          const expires = m.expires_at ? new Date(m.expires_at).toLocaleTimeString() : "?";
          lines.push(`    ${m.name.padEnd(25)} VRAM: ${vram.padEnd(10)} RAM: ${ram.padEnd(10)} Expires: ${expires}`);
        }
      } else {
        lines.push(``, `  No models currently loaded in memory.`);
      }

      // Memory headroom analysis
      const freeGB = freeMem / 1e9;
      lines.push(
        ``,
        `MEMORY HEADROOM:`,
        `  Available for models: ~${freeGB.toFixed(1)}GB`,
        freeGB > 12
          ? `  Status: PLENTY — can load 14B+ models comfortably`
          : freeGB > 6
          ? `  Status: OK — can load 7B models, 14B might be tight`
          : freeGB > 3
          ? `  Status: LOW — stick to 3B-7B models`
          : `  Status: CRITICAL — close other apps before running models`
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

const transport = new StdioServerTransport();
await server.connect(transport);
