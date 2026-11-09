"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const { BIN } = require("./helpers");
const pkg = require("../package.json");

const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("--version and --help", () => {
    assert.equal(run("--version").stdout.trim(), pkg.version);
    const help = run("--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: sentinel-ir-mcp/);
});

test("server.json for the MCP Registry matches package.json", () => {
    const server = require("../server.json");
    assert.equal(server.name, pkg.mcpName);
    assert.equal(server.version, pkg.version);
    assert.deepEqual(server.packages.map((p) => [p.identifier, p.version]), [[pkg.name, pkg.version]]);
});

test("invalid arguments exit with code 2", () => {
    for (const args of [["--nope"], ["/definitely/not/here"], ["--max-files", "0"], ["--max-files=501"], ["--max-file-bytes", "abc"]]) {
        const r = run(...args);
        assert.equal(r.status, 2, args.join(" "));
        assert.match(r.stderr, /sentinel-ir-mcp:/);
    }
});

test("package metadata is publishable", () => {
    assert.equal(pkg.bin["sentinel-ir-mcp"], "bin/sentinel-ir-mcp.js");
    assert.equal(pkg.license, "Apache-2.0");
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@modelcontextprotocol/sdk", "sentinel-ir", "zod"]);
});

const fsx = require("fs");
const osx = require("os");
const pathx = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

test("guide prints the agent workflow and writes nothing", () => {
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "sentinel-ir-guide-"));
    try {
        const r = spawnSync(process.execPath, [BIN, "guide"], { encoding: "utf8", cwd: dir });
        assert.equal(r.status, 0);
        assert.match(r.stdout, /analyze_directory/);
        assert.match(r.stdout, /skipped\.unreadable/);
        assert.match(r.stdout, /NOT evidence of safety/);
        assert.deepEqual(fsx.readdirSync(dir), []);
    } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test("subcommands: --help, unknown options exit 2; help lists the commands", () => {
    assert.match(run("--help").stdout, /setup \| doctor \| guide/);
    for (const cmd of ["setup", "doctor", "guide"]) {
        const help = run(cmd, "--help");
        assert.equal(help.status, 0);
        assert.match(help.stdout, new RegExp(`Usage: sentinel-ir-mcp ${cmd}`));
        const bad = run(cmd, "--nope");
        assert.equal(bad.status, 2, cmd);
        assert.match(bad.stderr, /unknown option --nope/);
    }
    assert.equal(run("setup", "--client").status, 2);
    assert.equal(run("guide", "extra").status, 2);
});

test("a folder named 'setup' is still reachable as ./setup; bare 'setup' is now the command", async () => {
    const base = fsx.realpathSync(fsx.mkdtempSync(pathx.join(osx.tmpdir(), "sentinel-ir-compat-")));
    fsx.mkdirSync(pathx.join(base, "setup"));
    fsx.writeFileSync(pathx.join(base, "setup", "x.js"), "eval(a);\n");
    try {
        const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "./setup"], cwd: base, stderr: "pipe" });
        const client = new Client({ name: "compat", version: "0" });
        await client.connect(transport);
        const r = await client.callTool({ name: "analyze_directory", arguments: { path: pathx.join(base, "setup") } });
        assert.equal(r.isError, undefined);
        assert.equal(r.structuredContent.analyzed, 1);
        await client.close();

        const cmd = spawnSync(process.execPath, [BIN, "setup"], { encoding: "utf8", cwd: base, input: "" });
        assert.equal(cmd.status, 1);
        assert.match(cmd.stderr, /--client/);
        assert.deepEqual(fsx.readdirSync(base), ["setup"]);
    } finally { fsx.rmSync(base, { recursive: true, force: true }); }
});
