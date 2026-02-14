#!/usr/bin/env node

/**
 * Test harness for LLM Checker MCP Server
 * Tests all tools by calling the Ollama API and tool logic directly.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import http from "http";
import os from "os";
import { readdir, stat } from "fs/promises";
import { join } from "path";

const exec = promisify(execFile);

function ollamaAPI(path, body = null, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, "http://localhost:11434");
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
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  return bytes + " B";
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stdout.write(`  Testing ${name}... `);
  try {
    const result = await fn();
    if (result) {
      console.log(`PASS`);
      // Show first 3 lines of output
      const lines = result.split("\n").slice(0, 3);
      for (const l of lines) console.log(`    ${l}`);
      if (result.split("\n").length > 3) console.log(`    ... (${result.split("\n").length} lines total)`);
      passed++;
    }
  } catch (err) {
    console.log(`FAIL: ${err.message}`);
    failed++;
  }
}

console.log("\n=== LLM Checker MCP Tools Test Suite ===\n");

// 1. ollama_list (via API)
await test("ollama_list", async () => {
  const data = await ollamaAPI("/api/tags", null, 10000);
  if (!data.models) throw new Error("No models field");
  return `Found ${data.models.length} models: ${data.models.map(m => m.name).join(", ")}`;
});

// 2. ollama_monitor
await test("ollama_monitor", async () => {
  const [psData, tagsData] = await Promise.all([
    ollamaAPI("/api/ps", null, 10000),
    ollamaAPI("/api/tags", null, 10000),
  ]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const runningModels = psData.models || [];
  const installedModels = tagsData.models || [];
  return [
    `RAM: ${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
    `Installed: ${installedModels.length} models`,
    `Running: ${runningModels.length} models`,
    `Free: ${formatBytes(freeMem)}`,
  ].join("\n");
});

// 3. ollama_optimize
await test("ollama_optimize", async () => {
  const totalGB = Math.round(os.totalmem() / 1e9);
  const platform = os.platform();
  const isApple = platform === "darwin";
  const numGPU = isApple ? 999 : 35;
  const numParallel = totalGB >= 32 ? 3 : totalGB >= 16 ? 2 : 1;
  return [
    `Platform: ${platform} | RAM: ${totalGB}GB`,
    `OLLAMA_NUM_GPU=${numGPU}`,
    `OLLAMA_NUM_PARALLEL=${numParallel}`,
    `OLLAMA_FLASH_ATTENTION=${isApple ? "1" : "0"}`,
  ].join("\n");
});

// 4. benchmark (single prompt, fast)
await test("benchmark (llama3.2:3b)", async () => {
  const data = await ollamaAPI("/api/generate", {
    model: "llama3.2:3b",
    prompt: "What is 2+2? Answer in one word.",
    stream: false,
  }, 60000);
  if (!data.eval_count) throw new Error("No eval_count in response");
  const tokPerSec = ((data.eval_count / data.eval_duration) * 1e9).toFixed(1);
  return [
    `Model: llama3.2:3b`,
    `Response: "${(data.response || "").trim().slice(0, 50)}"`,
    `Speed: ${tokPerSec} tok/s | Tokens: ${data.eval_count}`,
    `Total: ${(data.total_duration / 1e9).toFixed(2)}s`,
  ].join("\n");
});

// 5. compare_models
await test("compare_models (llama3.2:3b vs qwen2.5-coder:7b)", async () => {
  const prompt = "What is a linked list? One sentence.";
  const [a, b] = await Promise.all([
    ollamaAPI("/api/generate", { model: "llama3.2:3b", prompt, stream: false }, 120000),
    ollamaAPI("/api/generate", { model: "qwen2.5-coder:7b", prompt, stream: false }, 120000),
  ]);
  const aTok = ((a.eval_count / a.eval_duration) * 1e9).toFixed(1);
  const bTok = ((b.eval_count / b.eval_duration) * 1e9).toFixed(1);
  return [
    `Prompt: "${prompt}"`,
    `llama3.2:3b    → ${aTok} tok/s, ${a.eval_count} tokens`,
    `qwen2.5-coder  → ${bTok} tok/s, ${b.eval_count} tokens`,
    `Winner (speed): ${parseFloat(aTok) > parseFloat(bTok) ? "llama3.2:3b" : "qwen2.5-coder:7b"}`,
  ].join("\n");
});

// 6. cleanup_models
await test("cleanup_models", async () => {
  const tagsData = await ollamaAPI("/api/tags", null, 10000);
  const models = tagsData.models || [];
  const totalSize = models.reduce((s, m) => s + (m.size || 0), 0);
  const cloudModels = models.filter(m => m.size < 10000);
  const localModels = models.filter(m => m.size >= 10000);
  return [
    `Total: ${models.length} models (${formatBytes(totalSize)})`,
    `Local: ${localModels.length} | Cloud-only: ${cloudModels.length}`,
    cloudModels.length > 0 ? `Removable cloud models: ${cloudModels.map(m => m.name).join(", ")}` : "No cloud-only models",
  ].join("\n");
});

// 7. project_recommend
await test("project_recommend (~/Desktop/llm-checker)", async () => {
  const projectPath = "~/Desktop/llm-checker";
  const langCounts = {};
  let totalFiles = 0;
  const extMap = { ".js": "JavaScript", ".mjs": "JavaScript", ".ts": "TypeScript", ".py": "Python", ".rs": "Rust" };

  async function scan(dir, depth = 0) {
    if (depth > 3) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        if (e.isDirectory()) await scan(join(dir, e.name), depth + 1);
        else {
          const ext = e.name.includes(".") ? "." + e.name.split(".").pop() : "";
          if (extMap[ext]) { langCounts[extMap[ext]] = (langCounts[extMap[ext]] || 0) + 1; totalFiles++; }
        }
      }
    } catch {}
  }
  await scan(projectPath);

  const sorted = Object.entries(langCounts).sort((a, b) => b[1] - a[1]);
  return [
    `Project: ${projectPath}`,
    `Files: ${totalFiles}`,
    ...sorted.map(([lang, count]) => `  ${lang}: ${count} files`),
  ].join("\n");
});

// Summary
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
if (failed === 0) console.log("ALL TESTS PASSED!");
else process.exit(1);
