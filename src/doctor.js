"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { version, dependencies } = require("../package.json");
const { SERVER_NAME, PACKAGE_SPEC, homeOf, WORKSPACE_VAR, CLIENTS, FILE_CLIENTS, isWindowsNpxWrapper, entryExcludes, entryAuditLog, serverFlags } = require("./clients");
const { AuditLogError, defaultAuditDir, normalizeAuditDir, assertOutsideProjects, logFiles, dayName, createAuditLog } = require("./auditLog");
const { readConfig } = require("./setup");
const { createExcluder, ExcludeError } = require("./exclude");
const { SKIP_DIRS } = require("./analyze");
const { describeExcluded } = require("./excludeReport");

const BIN = path.join(__dirname, "..", "bin", "sentinel-ir-mcp.js");
const EXPECTED_TOOLS = ["analyze_code", "analyze_directory", "analyze_file"];
const VALUE_OPTIONS = new Set(["--max-file-bytes", "--max-files", "--time-budget-ms", "--exclude"]);

const IR_MIN = dependencies["sentinel-ir"].replace(/^[\^~>=]+/, "");

function irVersion() {
    try {
        return require("sentinel-ir/package.json").version;
    } catch {
        return "unknown";
    }
}

// true when version a is older than b ("unknown" or junk counts as older).
function olderThan(a, b) {
    const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(String(a));
    if (!pa) return true;
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (Number(pa[i + 1]) !== pb[i]) return Number(pa[i + 1]) < pb[i];
    return false;
}

function readVersion(file) {
    try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")).version;
        return typeof v === "string" ? v : "unknown";
    } catch {
        return "unknown";
    }
}

const PACKAGE_DIR = path.join(__dirname, "..");

// The _npx/<key> folder the package in dir was started from, or null.
function npxCopyDir(dir = PACKAGE_DIR) {
    const m = /^(.*[\\/]_npx[\\/][^\\/]+)[\\/]/.exec(dir);
    return m ? m[1] : null;
}

// Where the package in dir is installed: an npx cache copy, a global install or elsewhere.
function installKind(dir) {
    const npx = npxCopyDir(dir);
    if (npx) return { kind: "npx", dir: npx, key: /[^\\/]+$/.exec(npx)[0] };
    if (/[\\/](lib|npm)[\\/]node_modules[\\/]sentinel-ir-mcp[\\/]?$/i.test(dir)) return { kind: "global", dir };
    return { kind: "other", dir };
}

// npm dist-tags of sentinel-ir-mcp, or null when the registry does not answer in time.
function fetchDistTags(env, timeoutMs = 3000) {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL("-/package/sentinel-ir-mcp/dist-tags", (env.npm_config_registry || "https://registry.npmjs.org/").replace(/\/?$/, "/"));
        } catch { resolve(null); return; }
        const lib = url.protocol === "http:" ? http : url.protocol === "https:" ? https : null;
        if (!lib) { resolve(null); return; }
        const req = lib.get(url, { timeout: timeoutMs, headers: { accept: "application/json" } }, (res) => {
            if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (d) => { body += d; if (body.length > 65536) { resolve(null); req.destroy(); } });
            res.on("end", () => {
                try {
                    const tags = JSON.parse(body);
                    resolve(tags && typeof tags === "object" && !Array.isArray(tags) ? tags : null);
                } catch { resolve(null); }
            });
        });
        const timer = setTimeout(() => req.destroy(), timeoutMs);
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(null));
        req.on("close", () => { clearTimeout(timer); resolve(null); });
    });
}

// Warns when npm has a newer release on this version's stable-X.Y tag; says where this copy runs from.
async function checkUpdate(io, add) {
    if (typeof io.fetchDistTags !== "function") return;
    const m = /^(\d+)\.(\d+)\./.exec(version);
    const tag = m ? `stable-${m[1]}.${m[2]}` : "latest";
    const tags = await io.fetchDistTags(io.env);
    if (!tags) {
        add("skip", "package.update", "Could not reach the npm registry to look for a newer sentinel-ir-mcp (offline or blocked)");
        return;
    }
    const newest = tags[tag];
    if (typeof newest !== "string" || !/^\d+\.\d+\.\d+$/.test(newest)) {
        add("skip", "package.update", `npm has no ${tag} tag for sentinel-ir-mcp`);
        return;
    }
    if (!olderThan(version, newest)) {
        add("ok", "package.update", `sentinel-ir-mcp ${version} is the newest ${tag} on npm`);
        return;
    }
    const spec = `sentinel-ir-mcp@${tag}`;
    const from = installKind(io.packageDir || PACKAGE_DIR);
    const where = { npx: `the npx cache (${from.dir})`, global: `a global install (${from.dir})`, other: from.dir }[from.kind];
    const fix = {
        npx: `Close the client, delete that folder (npm 11: npm cache npx rm ${from.key}), then run: npx -y ${spec} setup`,
        global: `Run: npm install -g ${spec} (or npm uninstall -g sentinel-ir-mcp), then: npx -y ${spec} doctor`,
        other: `Run the current version: npx -y ${spec} doctor`
    }[from.kind];
    add("warn", "package.update", `This is sentinel-ir-mcp ${version}, npm has ${newest} (${tag}); this copy runs from ${where}`, fix);
}

// npm's cache folder: the one this copy was started from by npx, else npm's default.
function npmCacheDir(env, platform) {
    const marker = `${path.sep}_npx${path.sep}`;
    const i = __dirname.lastIndexOf(marker);
    if (i > 0) return __dirname.slice(0, i);
    if (env.npm_config_cache) return env.npm_config_cache;
    if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homeOf(env), "AppData", "Local"), "npm-cache");
    return path.join(homeOf(env), ".npm");
}

// Copies of sentinel-ir-mcp that npx cached and whose sentinel-ir is older
// than this release needs. npx keeps starting such a copy for its spec.
function staleNpxCopies(cacheDir) {
    const root = path.join(cacheDir, "_npx");
    let keys;
    try { keys = fs.readdirSync(root); } catch { return []; }
    const stale = [];
    for (const key of keys.sort()) {
        const dir = path.join(root, key);
        const mod = path.join(dir, "node_modules");
        if (!fs.existsSync(path.join(mod, "sentinel-ir-mcp", "package.json"))) continue;
        // npm nests sentinel-ir under the server when another package in this
        // npx folder needs a different sentinel-ir at the top level.
        const nested = path.join(mod, "sentinel-ir-mcp", "node_modules", "sentinel-ir", "package.json");
        const ir = readVersion(fs.existsSync(nested) ? nested : path.join(mod, "sentinel-ir", "package.json"));
        if (!olderThan(ir, IR_MIN)) continue;
        let spec = "sentinel-ir-mcp";
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
            const named = pkg._npx && Array.isArray(pkg._npx.packages) && pkg._npx.packages.find((p) => /^sentinel-ir-mcp(@|$)/.test(p));
            if (named) spec = named;
            else if (pkg.dependencies && typeof pkg.dependencies["sentinel-ir-mcp"] === "string") spec = `sentinel-ir-mcp@${pkg.dependencies["sentinel-ir-mcp"]}`;
        } catch { /* keep the bare name */ }
        stale.push({ key, dir, spec, mcp: readVersion(path.join(mod, "sentinel-ir-mcp", "package.json")), ir });
    }
    return stale;
}

function checkNpxCache(env, platform, add) {
    const cacheDir = npmCacheDir(env, platform);
    const stale = staleNpxCopies(cacheDir);
    if (stale.length === 0) {
        add("ok", "npx.cache", `npx cache (${path.join(cacheDir, "_npx")}): no copy with sentinel-ir older than ${IR_MIN}`);
        return;
    }
    for (const c of stale) {
        add("warn", "npx.cache", `npx keeps starting a cached ${c.spec} (sentinel-ir-mcp ${c.mcp}, sentinel-ir ${c.ir}) from ${c.dir}; sentinel-ir older than ${IR_MIN} misses security fixes`,
            `Close the client, delete that folder (npm 11: npm cache npx rm ${c.key}), then run: npx -y ${PACKAGE_SPEC} setup`);
    }
}

// The version part of the configured sentinel-ir-mcp argument, "" when none.
function entrySpec(args) {
    const a = args.find((x) => typeof x === "string" && /^sentinel-ir-mcp(@|$)/.test(x));
    return a ? a.slice("sentinel-ir-mcp@".length) : "";
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

// The entry's exclusions as the server will apply them; null if one is invalid.
function checkExcludes(client, label, args, file, add) {
    const raw = entryExcludes(args);
    try {
        return createExcluder(raw).patterns;
    } catch (e) {
        if (!(e instanceof ExcludeError)) throw e;
        add("fail", `${client}.exclude`, `${label}: ${e.message}; the server will not start`,
            `Run setup again with --exclude, or fix it in ${file}.`);
        return null;
    }
}

function checkConfig(client, file, explicit, project, add, platform, env) {
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
    } else if (/^[\^~=v]*0\.[0-4](\.|$)/.test(entrySpec(args))) {
        add("warn", `${client}.entry`, runs, `This entry stays on an older version without Rust support. Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
    } else if (/^[\^~=v<>]*\d/.test(entrySpec(args))) {
        add("warn", `${client}.entry`, runs, `npx keeps starting the copy it downloaded first for a version or range and misses later fixes. Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
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
    const exclude = checkExcludes(client, label, args, file, add);
    if (exclude === null) return null;
    let audit = entryAuditLog(args);
    if (audit) {
        try {
            const dir = audit.dir ? normalizeAuditDir(audit.dir) : defaultAuditDir(env, platform);
            assertOutsideProjects(dir, resolved);
            audit = { dir: audit.dir ? dir : null, path: dir };
        } catch (e) {
            if (!(e instanceof AuditLogError)) throw e;
            add("fail", `${client}.audit`, `${label}: ${e.message}; the server will not start`,
                `Run: npx -y ${PACKAGE_SPEC} setup --client ${client} --audit-log  (or --no-audit-log)`);
            return { folders: resolved, exclude, audit: null, auditBroken: true };
        }
    }
    return { folders: resolved, exclude, audit };
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function describeAuditFolder(dir) {
    const files = logFiles(dir);
    let bytes = 0;
    for (const f of files) {
        try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* removed meanwhile */ }
    }
    return files.length ? `${files.length} day(s), ${formatBytes(bytes)}` : "empty so far";
}

function fileSize(file) {
    try { return fs.statSync(file).size; } catch { return -1; }
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); })
    ]).finally(() => clearTimeout(timer));
}

async function checkHandshake(folders, exclude, audit, add, timeoutMs) {
    // Without the audit log, so the check does not fill it with its own calls;
    // the log is proved below with one "check" line from the same writer.
    const flags = serverFlags(exclude, null);
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...flags, ...folders], stderr: "pipe" });
    const today = audit ? path.join(audit.path, dayName(new Date())) : null;
    const before = today ? fileSize(today) : -1;
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
    if (!audit) return;
    const log = createAuditLog({ dir: audit.path, onError: () => {} });
    log.record({ event: "check", version });
    await log.flush();
    if (fileSize(today) > before) add("ok", "audit.write", `Audit log: can be written (doctor added one "check" line to ${today})`);
    else add("fail", "audit.write", `Audit log: nothing could be written to ${audit.path}`,
        "Check that the folder exists or can be created and that you may write to it (disk full?). The tools still work without the log.");
}

const MARK = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" };

async function runDoctor(opts, io) {
    const checks = [];
    const add = (status, id, message, fix) => checks.push(fix ? { status, id, message, fix } : { status, id, message });

    const nodeVersion = io.nodeVersion || process.versions.node;
    if (Number(nodeVersion.split(".")[0]) >= 20) add("ok", "node", `Node.js v${nodeVersion}`);
    else add("fail", "node", `Node.js v${nodeVersion} is too old`, "Install Node.js 20 or newer.");
    const ir = irVersion();
    if (olderThan(ir, IR_MIN)) {
        add("fail", "package", `sentinel-ir-mcp ${version} runs sentinel-ir ${ir}, needs ${IR_MIN} or newer`,
            npxCopyDir() ? `Close the client, delete ${npxCopyDir()}, then run: npx -y ${PACKAGE_SPEC} setup` : `Reinstall it so that npm installs sentinel-ir ${dependencies["sentinel-ir"]}.`);
    } else add("ok", "package", `sentinel-ir-mcp ${version}, sentinel-ir ${ir}`);
    await checkUpdate(io, add);
    checkNpxCache(io.env, io.platform, add);

    const project = path.resolve(io.cwd, opts.project || ".");
    if (opts.client && !Object.prototype.hasOwnProperty.call(CLIENTS, opts.client)) {
        add("fail", "client", `Unknown client "${opts.client}"`, `Use one of: ${Object.keys(CLIENTS).join(", ")}.`);
    } else if (opts.client && CLIENTS[opts.client].kind === "command") {
        add("skip", `${opts.client}.config`, `${CLIENTS[opts.client].label} keeps its own server list; check it there (VS Code: "MCP: List Servers", Claude Code: "claude mcp list").`);
    }
    const names = opts.client ? (CLIENTS[opts.client] && CLIENTS[opts.client].kind === "file" ? [opts.client] : []) : FILE_CLIENTS;
    let folders = null;
    let exclude = [];
    let audit = null;
    let auditBroken = false;
    for (const client of names) {
        const ctx = { project, global: Boolean(opts.global), env: io.env, platform: io.platform };
        let file = opts.config ? path.resolve(io.cwd, opts.config) : CLIENTS[client].configPath(ctx);
        const legacy = !opts.config && CLIENTS[client].legacyConfigPath ? CLIENTS[client].legacyConfigPath(ctx) : null;
        if (legacy && !(file && fs.existsSync(file)) && fs.existsSync(legacy)) {
            add("warn", `${client}.location`, `${CLIENTS[client].label}: only the old config ${legacy} exists`,
                `Current ${CLIENTS[client].label} reads ${file || "a new location"}. Run: npx -y ${PACKAGE_SPEC} setup --client ${client}`);
            file = legacy;
        }
        const found = checkConfig(client, file, Boolean(opts.client), project, add, io.platform, io.env);
        if (found && folders === null) ({ folders, exclude, audit, auditBroken = false } = found);
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
    for (const line of describeExcluded(exclude, folders, SKIP_DIRS)) add("ok", "exclude", line);
    if (audit) add("ok", "audit", `Audit log: on, in ${audit.path} (${describeAuditFolder(audit.path)}); see it: npx -y ${PACKAGE_SPEC} log${audit.dir ? ` --dir "${audit.dir}"` : ""}`);
    else if (!auditBroken) add("ok", "audit", `Audit log: off (turn it on: npx -y ${PACKAGE_SPEC} setup --audit-log)`);
    await checkHandshake(folders, exclude, audit, add, opts.timeoutMs || 30000);

    const failed = checks.some((c) => c.status === "fail");
    if (opts.json) {
        io.stdout.write(JSON.stringify({ ok: !failed, checks }, null, 2) + "\n");
    } else {
        for (const c of checks) io.stdout.write(`${MARK[c.status]} ${c.message}\n${c.fix ? `       -> ${c.fix}\n` : ""}`);
        const warnings = checks.filter((c) => c.status === "warn").length;
        const warned = warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""} above` : "";
        io.stdout.write(failed ? `\nSome checks failed${warned}.\n` : `\nAll checks passed${warned}.\n`);
    }
    return failed ? 1 : 0;
}

module.exports = { runDoctor, entryFolders, olderThan, staleNpxCopies, fetchDistTags, installKind, IR_MIN };
