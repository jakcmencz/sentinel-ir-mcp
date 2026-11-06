"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { version } = require("../package.json");
const { SERVER_NAME, PACKAGE_SPEC, WORKSPACE_VAR, CLIENTS, FILE_CLIENTS, isWindowsNpxWrapper } = require("./clients");
const { readConfig } = require("./setup");

const BIN = path.join(__dirname, "..", "bin", "sentinel-ir-mcp.js");
const EXPECTED_TOOLS = ["analyze_code", "analyze_directory", "analyze_file"];
const VALUE_OPTIONS = new Set(["--max-file-bytes", "--max-files", "--time-budget-ms"]);

function irVersion() {
    try {
        return require("sentinel-ir/package.json").version;
    } catch {
        return "unknown";
    }
}

// Folders the configured entry passes to the server (arguments after the package).
function entryFolders(args) {
    const i = args.findIndex((a) => typeof a === "string" && /^sentinel-ir-mcp(@|$)/.test(a));
    if (i < 0) return null;
    const folders = [];
    for (let j = i + 1; j < args.length; j++) {
        const a = String(args[j]);
        if (VALUE_OPTIONS.has(a)) j++;
        else if (!a.startsWith("-")) folders.push(a);
    }
    return folders;
}

function checkConfig(client, file, explicit, project, add, platform) {
    const label = CLIENTS[client].label;
    if (!file) {
        if (explicit) add("fail", `${client}.config`, `${label}: config location unknown on this system`, "Pass the config path with --config <file>.");
        return null;
    }
    if (!fs.existsSync(file)) {
        if (explicit) add("fail", `${client}.config`, `${label}: ${file} not found`, `Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
        else add("skip", `${client}.config`, `${label}: no config at ${file}`);
        return null;
    }
    let data;
    try {
        ({ data } = readConfig(file));
    } catch (e) {
        add("fail", `${client}.config`, `${label}: ${e.message}`, "Fix the JSON syntax in that file.");
        return null;
    }
    const entry = data.mcpServers && Object.prototype.hasOwnProperty.call(data.mcpServers, SERVER_NAME) ? data.mcpServers[SERVER_NAME] : undefined;
    if (entry === undefined) {
        if (explicit) add("fail", `${client}.entry`, `${label}: no "${SERVER_NAME}" server in ${file}`, `Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
        else add("skip", `${client}.entry`, `${label}: ${file} has no "${SERVER_NAME}" server`);
        return null;
    }
    const args = entry && Array.isArray(entry.args) ? entry.args : [];
    const folders = entryFolders(args);
    if (!entry || typeof entry.command !== "string" || folders === null) {
        add("fail", `${client}.entry`, `${label}: "${SERVER_NAME}" does not start sentinel-ir-mcp (${JSON.stringify(entry)})`,
            `Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
        return null;
    }
    const runs = `${label}: "${SERVER_NAME}" runs ${entry.command} ${args.join(" ")}`;
    if (entry.command === "npx" && platform === "win32") {
        add("warn", `${client}.entry`, runs, `On Windows a client may not find "npx" without a shell. Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
    } else if (args.some(a => /^sentinel-ir-mcp@0\.[0-3](\.|$)/.test(a))) {
        add("warn", `${client}.entry`, runs, `This entry stays on an older version without native-code detection, whose parser stops working in long sessions. Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
    } else if (entry.command === "npx" || isWindowsNpxWrapper(entry)) {
        add("ok", `${client}.entry`, runs);
    } else {
        add("warn", `${client}.entry`, runs, `Expected "npx"; make sure "${entry.command}" starts sentinel-ir-mcp.`);
    }
    const resolved = [];
    for (const f of folders) {
        const real = f === WORKSPACE_VAR ? project : path.resolve(f);
        let isDir = false;
        try { isDir = fs.statSync(real).isDirectory(); } catch { /* reported below */ }
        if (isDir) resolved.push(real);
        else add("fail", `${client}.folder`, `${label}: folder ${f}${f === WORKSPACE_VAR ? ` (= ${real})` : ""} does not exist`,
            `Run setup again from the project folder, or fix the path in ${file}.`);
    }
    if (folders.length === 0) add("warn", `${client}.folder`, `${label}: no folder given; the file tools rely on the client's MCP roots`);
    return resolved;
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); })
    ]).finally(() => clearTimeout(timer));
}

async function checkHandshake(folders, add, timeoutMs) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...folders], stderr: "pipe" });
    const client = new Client({ name: "sentinel-ir-mcp-doctor", version });
    try {
        await withTimeout(client.connect(transport), timeoutMs, "MCP handshake");
        const info = client.getServerVersion();
        add("ok", "mcp.handshake", `MCP handshake with ${info.name} ${info.version}`);
        const tools = (await withTimeout(client.listTools(), timeoutMs, "tools/list")).tools.map((t) => t.name).sort();
        if (JSON.stringify(tools) === JSON.stringify(EXPECTED_TOOLS)) add("ok", "mcp.tools", `Tools: ${tools.join(", ")}`);
        else add("fail", "mcp.tools", `Unexpected tools: ${tools.join(", ")}`, `Reinstall: npx -y ${PACKAGE_SPEC} --version`);
        if (folders.length) {
            const r = await withTimeout(client.callTool({ name: "analyze_directory", arguments: { path: folders[0], max_files: 1 } }), timeoutMs, "analyze_directory");
            if (r.isError) add("fail", "mcp.call", `analyze_directory failed: ${r.content[0].text}`, "Check that the folder is readable.");
            else add("ok", "mcp.call", `analyze_directory works on ${folders[0]} (${r.structuredContent.analyzed} file(s) checked)`);
        }
    } catch (e) {
        add("fail", "mcp.handshake", `MCP connection failed: ${e.message}`, `Run npx -y ${PACKAGE_SPEC} --help to see whether the package starts.`);
    } finally {
        await client.close().catch(() => {});
    }
}

const MARK = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" };

async function runDoctor(opts, io) {
    const checks = [];
    const add = (status, id, message, fix) => checks.push(fix ? { status, id, message, fix } : { status, id, message });

    const nodeVersion = io.nodeVersion || process.versions.node;
    if (Number(nodeVersion.split(".")[0]) >= 20) add("ok", "node", `Node.js v${nodeVersion}`);
    else add("fail", "node", `Node.js v${nodeVersion} is too old`, "Install Node.js 20 or newer.");
    add("ok", "package", `sentinel-ir-mcp ${version}, sentinel-ir ${irVersion()}`);

    const project = path.resolve(io.cwd, opts.project || ".");
    if (opts.client && !Object.prototype.hasOwnProperty.call(CLIENTS, opts.client)) {
        add("fail", "client", `Unknown client "${opts.client}"`, `Use one of: ${Object.keys(CLIENTS).join(", ")}.`);
    } else if (opts.client && CLIENTS[opts.client].kind === "command") {
        add("skip", `${opts.client}.config`, `${CLIENTS[opts.client].label} keeps its own server list; check it there (VS Code: "MCP: List Servers", Claude Code: "claude mcp list").`);
    }
    const names = opts.client ? (CLIENTS[opts.client] && CLIENTS[opts.client].kind === "file" ? [opts.client] : []) : FILE_CLIENTS;
    let folders = null;
    for (const client of names) {
        const ctx = { project, global: Boolean(opts.global), env: io.env, platform: io.platform };
        let file = opts.config ? path.resolve(io.cwd, opts.config) : CLIENTS[client].configPath(ctx);
        const legacy = !opts.config && CLIENTS[client].legacyConfigPath ? CLIENTS[client].legacyConfigPath(ctx) : null;
        if (legacy && !(file && fs.existsSync(file)) && fs.existsSync(legacy)) {
            add("warn", `${client}.location`, `${CLIENTS[client].label}: only the old config ${legacy} exists`,
                `Current ${CLIENTS[client].label} reads ${file || "a new location"}. Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
            file = legacy;
        }
        const found = checkConfig(client, file, Boolean(opts.client), project, add, io.platform);
        if (found && folders === null) folders = found;
    }
    if (folders === null) {
        let isDir = false;
        try { isDir = fs.statSync(project).isDirectory(); } catch { /* reported below */ }
        if (isDir) folders = [project];
        else {
            add("fail", "project", `Project folder ${project} does not exist`, "Pass an existing folder with --project.");
            folders = [];
        }
    }
    await checkHandshake(folders, add, opts.timeoutMs || 30000);

    const failed = checks.some((c) => c.status === "fail");
    if (opts.json) {
        io.stdout.write(JSON.stringify({ ok: !failed, checks }, null, 2) + "\n");
    } else {
        for (const c of checks) io.stdout.write(`${MARK[c.status]} ${c.message}\n${c.fix ? `       -> ${c.fix}\n` : ""}`);
        io.stdout.write(failed ? "\nSome checks failed.\n" : "\nAll checks passed.\n");
    }
    return failed ? 1 : 0;
}

module.exports = { runDoctor, entryFolders };
