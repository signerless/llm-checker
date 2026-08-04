// Tests for the verify_model MCP tool and the multi-client mcp-setup command.
//
// ESM (.mjs), run directly via `node <file>` like tests/mcp-server.test.mjs.
// The MCP server module is imported WITHOUT starting stdio (guarded behind
// runningAsEntry()); the exported `server` instance is exercised over an
// in-memory transport with a real MCP client. mcp-setup is tested by spawning
// the CLI with an isolated HOME, mirroring tests/modelvet-verify.test.js.

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { server } from "../bin/mcp-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "..", "bin", "enhanced_cli.js");
const MCP_SERVER_PATH = path.resolve(__dirname, "..", "bin", "mcp-server.mjs");

function runCli(args, home) {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: home,
      USERPROFILE: home,
    },
  });
}

function buildGguf({ version = 3, tensors = 0n, kvs = 0n } = {}) {
  const buf = Buffer.alloc(24);
  buf.write("GGUF", 0, "ascii");
  buf.writeUInt32LE(version, 4);
  buf.writeBigUInt64LE(tensors, 8);
  buf.writeBigUInt64LE(kvs, 16);
  return buf;
}

async function withMcpClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-multiclient-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function toolResultJson(result) {
  assert.ok(Array.isArray(result.content) && result.content.length > 0, "tool result must have content");
  assert.strictEqual(result.content[0].type, "text", "tool result content must be text");
  return JSON.parse(result.content[0].text);
}

async function testVerifyModelTool(tempDir) {
  await withMcpClient(async (client) => {
    // Tool is registered with the documented input schema.
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "verify_model");
    assert.ok(tool, "verify_model tool must be registered");
    const schema = tool.inputSchema;
    assert.ok(schema && schema.properties, "verify_model must have an input schema");
    assert.strictEqual(schema.properties.path.type, "string", "path must be a string");
    assert.deepStrictEqual(schema.required, ["path"], "path must be the only required field");
    assert.deepStrictEqual(
      schema.properties.format.enum,
      ["auto", "gguf", "safetensors"],
      "format must be an auto|gguf|safetensors enum"
    );

    // Valid 24-byte GGUF (magic + v3 + 0 tensors + 0 kvs) -> accepted.
    const okPath = path.join(tempDir, "ok.gguf");
    fs.writeFileSync(okPath, buildGguf());
    const okResult = await client.callTool({ name: "verify_model", arguments: { path: okPath } });
    const ok = toolResultJson(okResult);
    assert.strictEqual(ok.accepted, true, `valid GGUF must be accepted, got ${JSON.stringify(ok)}`);
    assert.strictEqual(ok.verdict, "accept");
    assert.strictEqual(ok.format, "gguf");
    assert.strictEqual(ok.file, okPath);
    assert.strictEqual(ok.sizeBytes, 24);

    // GGUF with unsupported version 99 -> rejected, VERSION_UNSUPPORTED.
    const badPath = path.join(tempDir, "bad.gguf");
    fs.writeFileSync(badPath, buildGguf({ version: 99 }));
    const badResult = await client.callTool({ name: "verify_model", arguments: { path: badPath } });
    const bad = toolResultJson(badResult);
    assert.notStrictEqual(badResult.isError, true, "a structural rejection is a completed verification result");
    assert.strictEqual(bad.accepted, false, "version-99 GGUF must be rejected");
    assert.strictEqual(bad.verdict, "reject");
    assert.strictEqual(bad.violationName, "VERSION_UNSUPPORTED");

    // Missing path -> structured payload marked as an MCP tool error. The
    // client still receives machine-readable ModelVet details.
    const missingResult = await client.callTool({
      name: "verify_model",
      arguments: { path: path.join(tempDir, "missing.gguf") },
    });
    const missing = toolResultJson(missingResult);
    assert.strictEqual(missingResult.isError, true, "verifier infrastructure failures must set MCP isError");
    assert.strictEqual(missing.verdict, "error", "missing file must yield verdict 'error'");
    assert.ok(typeof missing.reason === "string" && missing.reason.length > 0, "error payload must carry a reason");
    assert.ok(typeof missing.code === "string" && missing.code.length > 0, "error payload must carry a code");
  });
}

async function testStdioHandshakeThroughSymlink(tempDir) {
  const shimDir = path.join(tempDir, "node_modules", ".bin");
  const shimPath = path.join(shimDir, "llm-checker-mcp");
  fs.mkdirSync(shimDir, { recursive: true });

  // npm creates package-bin symlinks on POSIX. Launching Node with that link
  // makes argv[1] differ from import.meta.url even though both identify the
  // same file; this is the exact installed-package regression being covered.
  fs.symlinkSync(MCP_SERVER_PATH, shimPath, "file");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [shimPath],
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-symlink-handshake-test", version: "0.0.0" });
  let timeout;

  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out waiting for MCP initialize through the npm-style symlink")),
          10_000
        );
      }),
    ]);

    // connect() completes the MCP initialize/initialized handshake. Listing
    // tools proves the child stayed up and is serving protocol messages.
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "verify_model"), "symlink-launched server must expose verify_model");
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {});
  }
}

function testMcpSetupClients(home) {
  const parseJsonRun = (args) => {
    const res = runCli(args, home);
    assert.strictEqual(res.status, 0, `mcp-setup ${args.join(" ")} failed: ${res.stderr}`);
    return JSON.parse(res.stdout);
  };

  // claude: legacy shape kept intact.
  const claude = parseJsonRun(["mcp-setup", "--client", "claude", "--json"]);
  assert.ok(
    claude.recommended.commandLine.includes("claude mcp add llm-checker -- llm-checker-mcp"),
    `claude commandLine mismatch: ${claude.recommended.commandLine}`
  );
  assert.strictEqual(
    claude.claudeDesktop.snippet.mcpServers["llm-checker"].command,
    "llm-checker-mcp",
    "claude desktop snippet must launch llm-checker-mcp"
  );

  // codex: TOML [mcp_servers.llm-checker] table for ~/.codex/config.toml.
  const codex = parseJsonRun(["mcp-setup", "--client", "codex", "--json"]);
  assert.strictEqual(codex.format, "toml");
  assert.ok(codex.configPath.endsWith(path.join(".codex", "config.toml")), `codex path: ${codex.configPath}`);
  assert.ok(codex.snippet.includes("[mcp_servers.llm-checker]"), `codex snippet: ${codex.snippet}`);
  assert.ok(codex.snippet.includes('command = "llm-checker-mcp"'), `codex snippet: ${codex.snippet}`);

  // cursor / windsurf / gemini: JSON mcpServers shape at their known paths.
  const cursor = parseJsonRun(["mcp-setup", "--client", "cursor", "--json"]);
  assert.ok(cursor.configPath.endsWith(path.join(".cursor", "mcp.json")), `cursor path: ${cursor.configPath}`);
  assert.strictEqual(cursor.snippet.mcpServers["llm-checker"].command, "llm-checker-mcp");

  const windsurf = parseJsonRun(["mcp-setup", "--client", "windsurf", "--json"]);
  assert.ok(
    windsurf.configPath.endsWith(path.join(".codeium", "windsurf", "mcp_config.json")),
    `windsurf path: ${windsurf.configPath}`
  );
  assert.strictEqual(windsurf.snippet.mcpServers["llm-checker"].command, "llm-checker-mcp");

  const gemini = parseJsonRun(["mcp-setup", "--client", "gemini", "--json"]);
  assert.ok(gemini.configPath.endsWith(path.join(".gemini", "settings.json")), `gemini path: ${gemini.configPath}`);
  assert.strictEqual(gemini.snippet.mcpServers["llm-checker"].command, "llm-checker-mcp");

  // kimi: mcpServers JSON + `kimi mcp add` command line; default path per docs.
  const kimi = parseJsonRun(["mcp-setup", "--client", "kimi", "--json"]);
  assert.ok(kimi.configPath.endsWith(path.join(".kimi", "mcp.json")), `kimi path: ${kimi.configPath}`);
  assert.strictEqual(kimi.snippet.mcpServers["llm-checker"].command, "llm-checker-mcp");
  assert.ok(kimi.commandLine.includes("kimi mcp add --transport stdio llm-checker -- llm-checker-mcp"), `kimi commandLine: ${kimi.commandLine}`);

  // grok: TOML table for ~/.grok/config.toml + `grok mcp add` command line.
  const grok = parseJsonRun(["mcp-setup", "--client", "grok", "--json"]);
  assert.strictEqual(grok.format, "toml");
  assert.ok(grok.configPath.endsWith(path.join(".grok", "config.toml")), `grok path: ${grok.configPath}`);
  assert.ok(grok.snippet.includes("[mcp_servers.llm-checker]"), `grok snippet: ${grok.snippet}`);
  assert.ok(grok.commandLine.includes("grok mcp add llm-checker -- llm-checker-mcp"), `grok commandLine: ${grok.commandLine}`);

  // generic: raw snippet only, no config path, no apply target.
  const generic = parseJsonRun(["mcp-setup", "--client", "generic", "--json"]);
  assert.strictEqual(generic.configPath, null);
  assert.strictEqual(generic.apply, null);
  assert.strictEqual(generic.snippet.mcpServers["llm-checker"].command, "llm-checker-mcp");

  // --npx must select the npm package explicitly. `llm-checker-mcp` is a bin
  // exposed by `llm-checker`, not a standalone package name.
  const npxArgs = ["--yes", "--package", "llm-checker", "llm-checker-mcp"];
  const npxClaude = parseJsonRun(["mcp-setup", "--client", "claude", "--npx", "--json"]);
  assert.deepStrictEqual(
    npxClaude.claudeDesktop.snippet.mcpServers["llm-checker"],
    { command: "npx", args: npxArgs }
  );
  assert.deepStrictEqual(
    npxClaude.recommended.args,
    ["mcp", "add", "llm-checker", "--", "npx", ...npxArgs]
  );

  for (const clientName of ["cursor", "windsurf", "gemini", "kimi", "generic"]) {
    const setup = parseJsonRun(["mcp-setup", "--client", clientName, "--npx", "--json"]);
    assert.deepStrictEqual(
      setup.snippet.mcpServers["llm-checker"],
      { command: "npx", args: npxArgs },
      `${clientName} must use the package-qualified npx command`
    );
  }

  for (const clientName of ["codex", "grok"]) {
    const setup = parseJsonRun(["mcp-setup", "--client", clientName, "--npx", "--json"]);
    assert.ok(setup.snippet.includes('command = "npx"'), `${clientName} npx snippet: ${setup.snippet}`);
    assert.ok(
      setup.snippet.includes('args = ["--yes", "--package", "llm-checker", "llm-checker-mcp"]'),
      `${clientName} npx snippet: ${setup.snippet}`
    );
    assert.ok(
      setup.commandLine.includes('npx --yes --package llm-checker llm-checker-mcp'),
      `${clientName} npx commandLine: ${setup.commandLine}`
    );
  }

  // Unknown client -> non-zero exit, no silent fallback.
  const bad = runCli(["mcp-setup", "--client", "nope", "--json"], home);
  assert.notStrictEqual(bad.status, 0, "unknown --client must exit non-zero");
}

function testMcpSetupApplyMerges() {
  // JSON merge (cursor): pre-existing content must survive.
  const cursorHome = fs.mkdtempSync(path.join(os.tmpdir(), "llm-checker-mcp-cursor-"));
  try {
    const cursorDir = path.join(cursorHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorPath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(
      cursorPath,
      JSON.stringify({ mcpServers: { other: { command: "other-mcp", args: [] } }, someOtherSetting: true }, null, 2)
    );

    const res = runCli(["mcp-setup", "--client", "cursor", "--apply"], cursorHome);
    assert.strictEqual(res.status, 0, `cursor --apply failed: ${res.stderr}`);

    const merged = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
    assert.deepStrictEqual(merged.mcpServers.other, { command: "other-mcp", args: [] }, "existing server must survive");
    assert.strictEqual(merged.someOtherSetting, true, "unrelated settings must survive");
    assert.deepStrictEqual(merged.mcpServers["llm-checker"], { command: "llm-checker-mcp", args: [] });
  } finally {
    fs.rmSync(cursorHome, { recursive: true, force: true });
  }

  // JSON merge (gemini): settings.json keys outside mcpServers must survive.
  const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), "llm-checker-mcp-gemini-"));
  try {
    const geminiDir = path.join(geminiHome, ".gemini");
    fs.mkdirSync(geminiDir, { recursive: true });
    const geminiPath = path.join(geminiDir, "settings.json");
    fs.writeFileSync(geminiPath, JSON.stringify({ theme: "dark" }, null, 2));

    const res = runCli(["mcp-setup", "--client", "gemini", "--apply"], geminiHome);
    assert.strictEqual(res.status, 0, `gemini --apply failed: ${res.stderr}`);

    const merged = JSON.parse(fs.readFileSync(geminiPath, "utf8"));
    assert.strictEqual(merged.theme, "dark", "existing settings must survive");
    assert.deepStrictEqual(merged.mcpServers["llm-checker"], { command: "llm-checker-mcp", args: [] });
  } finally {
    fs.rmSync(geminiHome, { recursive: true, force: true });
  }

  // TOML merge (codex): existing keys + other server tables must survive, and
  // re-applying replaces the table instead of duplicating it.
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "llm-checker-mcp-codex-"));
  try {
    const codexDir = path.join(codexHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(
      codexPath,
      ['model = "gpt-5"', "", "[mcp_servers.existing]", 'command = "existing-mcp"', ""].join("\n")
    );

    const first = runCli(["mcp-setup", "--client", "codex", "--apply"], codexHome);
    assert.strictEqual(first.status, 0, `codex --apply failed: ${first.stderr}`);
    // Second run must replace, not duplicate.
    const second = runCli(["mcp-setup", "--client", "codex", "--apply"], codexHome);
    assert.strictEqual(second.status, 0, `codex --apply (2nd) failed: ${second.stderr}`);

    const merged = fs.readFileSync(codexPath, "utf8");
    assert.ok(merged.includes('model = "gpt-5"'), "existing top-level keys must survive");
    assert.ok(merged.includes("[mcp_servers.existing]"), "existing server tables must survive");
    assert.ok(merged.includes('command = "existing-mcp"'), "existing server content must survive");
    const occurrences = merged.split("[mcp_servers.llm-checker]").length - 1;
    assert.strictEqual(occurrences, 1, `llm-checker table must appear exactly once, got ${occurrences}`);
    assert.ok(merged.includes('command = "llm-checker-mcp"'), "new server table must be present");
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }

  // Corrupt existing config: apply must refuse rather than clobber.
  const corruptHome = fs.mkdtempSync(path.join(os.tmpdir(), "llm-checker-mcp-corrupt-"));
  try {
    const cursorDir = path.join(corruptHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorPath = path.join(cursorDir, "mcp.json");
    fs.writeFileSync(cursorPath, "{ not valid json");

    const res = runCli(["mcp-setup", "--client", "cursor", "--apply"], corruptHome);
    assert.notStrictEqual(res.status, 0, "apply on corrupt JSON must fail");
    assert.strictEqual(
      fs.readFileSync(cursorPath, "utf8"),
      "{ not valid json",
      "corrupt config must be left untouched"
    );
  } finally {
    fs.rmSync(corruptHome, { recursive: true, force: true });
  }
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-checker-mcp-multi-"));
  const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), "llm-checker-mcp-home-"));
  try {
    await testVerifyModelTool(tempDir);
    await testStdioHandshakeThroughSymlink(tempDir);
    testMcpSetupClients(cliHome);
    testMcpSetupApplyMerges();
    console.log("mcp-multiclient tests: OK");
    process.exit(0);
  } catch (err) {
    console.error("mcp-multiclient tests: FAILED");
    console.error(err);
    process.exit(1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(cliHome, { recursive: true, force: true });
  }
}

run();
