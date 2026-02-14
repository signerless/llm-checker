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

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use the CLI from this package
const CLI_PATH = join(__dirname, "enhanced_cli.js");

// Strip ANSI escape codes for clean output
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

const server = new McpServer({
  name: "llm-checker",
  version: "3.1.0",
});

// --- Tool: hw_detect ---
server.tool(
  "hw_detect",
  "Detect hardware capabilities: CPU, GPU, RAM, acceleration backends, and recommended tier for running local LLMs",
  {},
  async () => {
    const result = await run(["hw-detect"]);
    return { content: [{ type: "text", text: result }] };
  }
);

// --- Tool: check ---
server.tool(
  "check",
  "Full system analysis: detect hardware, scan Ollama catalog, and return all compatible models ranked by score with memory estimates",
  {},
  async () => {
    const result = await run(["check"], 180000);
    return { content: [{ type: "text", text: result }] };
  }
);

// --- Tool: recommend ---
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

// --- Tool: installed ---
server.tool(
  "installed",
  "List and rank all locally installed Ollama models by compatibility score against current hardware",
  {},
  async () => {
    const result = await run(["installed"], 60000);
    return { content: [{ type: "text", text: result }] };
  }
);

// --- Tool: search ---
server.tool(
  "search",
  "Search the Ollama model catalog by keyword (e.g. 'code', 'vision', 'small'). Requires sql.js.",
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

// --- Tool: smart_recommend ---
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

// --- Tool: ollama_list ---
server.tool(
  "ollama_list",
  "List all models currently downloaded in Ollama with their sizes",
  {},
  async () => {
    try {
      const { stdout } = await exec("ollama", ["list"], { timeout: 10000 });
      return { content: [{ type: "text", text: clean(stdout) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Ollama not running or not installed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: ollama_pull ---
server.tool(
  "ollama_pull",
  "Download/pull a model from the Ollama registry to local storage",
  {
    model: z.string().describe("Model name to pull (e.g. 'qwen2.5-coder:7b', 'llama3.2:3b')"),
  },
  async ({ model }) => {
    try {
      const { stdout } = await exec("ollama", ["pull", model], { timeout: 600000 });
      return { content: [{ type: "text", text: clean(stdout) || `Successfully pulled ${model}` }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to pull ${model}: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// --- Tool: ollama_run ---
server.tool(
  "ollama_run",
  "Run a prompt against a local Ollama model and return the response",
  {
    model: z.string().describe("Model name (e.g. 'qwen2.5-coder:7b')"),
    prompt: z.string().describe("The prompt to send to the model"),
  },
  async ({ model, prompt }) => {
    try {
      const { stdout } = await exec("ollama", ["run", model, prompt], { timeout: 300000 });
      return { content: [{ type: "text", text: clean(stdout) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to run ${model}: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
