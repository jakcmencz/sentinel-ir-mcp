"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
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

// Where npm installs a global sentinel-ir-mcp: under npm's prefix setting, %APPDATA%\\npm, or next to node.
function globalDirs(env, platform, execPath) {
    const p = platform === "win32" ? path.win32 : path.posix;
    const prefixes = [env.npm_config_prefix, platform === "win32" && env.APPDATA ? p.join(env.APPDATA, "npm") : null,
        platform === "win32" ? p.dirname(execPath) : p.dirname(p.dirname(execPath))];
    const dirs = prefixes.filter(Boolean).map((x) => p.join(x, ...(platform === "win32" ? [] : ["lib"]), "node_modules", "sentinel-ir-mcp"));
    return [...new Set(dirs)];
}

const realDir = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
const sameDir = (a, b) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

// Where the package in dir is installed: an npx cache copy, a global install or elsewhere.
function installKind(dir, globals = []) {
    const npx = npxCopyDir(dir);
    if (npx) return { kind: "npx", dir: npx, key: /[^\\/]+$/.exec(npx)[0] };
    if (/[\\/](lib|npm)[\\/]node_modules[\\/]sentinel-ir-mcp[\\/]?$/i.test(dir) || globals.some((g) => sameDir(g, dir))) return { kind: "global", dir };
    return { kind: "other", dir };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const unescapeLogin = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// The proxy npm would use for url (https-proxy, then proxy; npm config before env), null for none,
// false for a proxy setting doctor cannot use (it then skips instead of going direct).
function proxyFor(url, env) {
    const noProxy = env.npm_config_noproxy || env.NO_PROXY || env.no_proxy || "";
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    for (const rule of noProxy.split(/[\s,]+/).filter(Boolean)) {
        const bare = /^\[(.*)\](:\d+)?$/.exec(rule)?.[1] ?? (rule.split(":").length === 2 ? rule.replace(/:\d+$/, "") : rule);
        const r = bare.replace(/^\*?\.?/, "").replace(/\.$/, "").toLowerCase();
        if (rule === "*" || host === r || host.endsWith("." + r)) return null;
    }
    // npm uses its https-proxy for http registries too.
    const raw = env.npm_config_https_proxy || env.HTTPS_PROXY || env.https_proxy || env.npm_config_proxy || env.HTTP_PROXY || env.http_proxy;
    if (!raw) return null;
    try {
        const p = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
        return p.protocol === "http:" || p.protocol === "https:" ? p : false;
    } catch { return false; }
}

// GET url directly or through proxy; calls back with the response. Adds every request it opens to open.
function openGet(url, env, tls, open, onResponse, onFail) {
    try { openGetOrThrow(url, env, tls, open, onResponse, onFail); } catch { onFail(); }
}

function openGetOrThrow(url, env, tls, open, onResponse, onFail) {
    // The registry login goes in a header we build: Node throws on a malformed % in URL credentials.
    const bare = new URL(url.href);
    bare.username = bare.password = "";
    const headers = { accept: "application/json",
        ...(url.username ? { authorization: "Basic " + Buffer.from(`${unescapeLogin(url.username)}:${unescapeLogin(url.password)}`).toString("base64") } : {}) };
    const proxy = proxyFor(url, env);
    if (proxy === false) { onFail(); return; }
    if (!proxy) {
        const req = (url.protocol === "https:" ? https : http).get(bare, { headers, ...tls }, onResponse);
        req.on("error", onFail);
        open.push(req);
        return;
    }
    const proxyLib = proxy.protocol === "https:" ? https : http;
    const auth = proxy.username
        ? { "proxy-authorization": "Basic " + Buffer.from(`${unescapeLogin(proxy.username)}:${unescapeLogin(proxy.password)}`).toString("base64") }
        : {};
    const target = { host: proxy.hostname.replace(/^\[|\]$/g, ""), port: proxy.port || (proxy.protocol === "https:" ? 443 : 80) };
    if (url.protocol === "http:") {
        const req = proxyLib.get({ ...target, path: bare.href, headers: { ...headers, ...auth, host: bare.host } }, onResponse);
        req.on("error", onFail);
        open.push(req);
        return;
    }
    const connect = proxyLib.request({ ...target, method: "CONNECT", path: `${url.hostname}:${url.port || 443}`, headers: { ...auth, host: `${url.hostname}:${url.port || 443}` } });
    connect.on("connect", (res, socket) => {
        if (res.statusCode !== 200) { socket.destroy(); onFail(); return; }
        const req = https.get(bare, {
            headers, ...tls,
            createConnection: () => require("tls").connect({ socket, host: url.hostname.replace(/^\[|\]$/g, ""), servername: net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname, ...tls })
        }, onResponse);
        req.on("error", onFail);
        open.push(req);
    });
    connect.on("error", onFail);
    connect.end();
    open.push(connect);
}

// npm's strict-ssl and cafile settings as TLS options.
function npmTls(env) {
    const t = {};
    if (/^false$/i.test(env.npm_config_strict_ssl || "")) t.rejectUnauthorized = false;
    if (env.npm_config_cafile) {
        try { t.ca = [...require("tls").rootCertificates, fs.readFileSync(env.npm_config_cafile, "utf8")]; } catch { /* npm fails here too */ }
    }
    return t;
}

// npm dist-tags of sentinel-ir-mcp, or null when the registry does not answer in time.
// Uses npm_config_registry and the proxy npm would use; follows up to 3 redirects.
function fetchDistTags(env, timeoutMs = 3000, tls = npmTls(env)) {
    return new Promise((resolve) => {
        let open = [];
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            for (const r of open) r.destroy();
            resolve(v);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        const get = (url, hops) => {
            if (url.protocol !== "http:" && url.protocol !== "https:") { finish(null); return; }
            openGet(url, env, tls, open, (res) => {
                if (REDIRECTS.has(res.statusCode) && res.headers.location && hops < 3) {
                    res.destroy();
                    let next;
                    try { next = new URL(res.headers.location, url); } catch { finish(null); return; }
                    if (url.protocol === "https:" && next.protocol !== "https:") { finish(null); return; }
                    get(next, hops + 1);
                    return;
                }
                if (res.statusCode !== 200) { res.resume(); finish(null); return; }
                const chunks = [];
                let size = 0;
                res.on("data", (d) => { chunks.push(d); size += d.length; if (size > 65536) finish(null); });
                res.on("end", () => {
                    try {
                        const tags = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                        finish(tags && typeof tags === "object" && !Array.isArray(tags) ? tags : null);
                    } catch { finish(null); }
                });
                res.on("error", () => finish(null));
                res.on("aborted", () => finish(null));
            }, () => finish(null));
        };
        let url;
        try {
            url = new URL("-/package/sentinel-ir-mcp/dist-tags", (env.npm_config_registry || "https://registry.npmjs.org/").replace(/\/?$/, "/"));
        } catch { finish(null); return; }
        get(url, 0);
    });
}

// Warns when npm has a newer release on this version's stable-X.Y tag; says where this copy runs from.
async function checkUpdate(io, add) {
    if (typeof io.fetchDistTags !== "function") return;
    const m = /^(\d+)\.(\d+)\./.exec(version);
    const tag = m ? `stable-${m[1]}.${m[2]}` : "latest";
    const tags = await io.fetchDistTags(io.env);
    if (!tags) {
        add("skip", "package.update", "No usable answer from the npm registry about a newer sentinel-ir-mcp (offline, blocked or an unexpected reply)");
        return;
    }
    const newest = Object.prototype.hasOwnProperty.call(tags, tag) ? tags[tag] : undefined;
    if (newest === undefined) {
        add("skip", "package.update", `npm has no ${tag} tag for sentinel-ir-mcp`);
        return;
    }
    if (typeof newest !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(newest)) {
        const shown = JSON.stringify(newest) ?? String(newest);
        add("skip", "package.update", `npm's ${tag} tag points to ${shown.length > 40 ? shown.slice(0, 40) + "..." : shown}, not a release version; no update check`);
        return;
    }
    if (newest === version) {
        add("ok", "package.update", `sentinel-ir-mcp ${version} is the newest ${tag} on npm`);
        return;
    }
    if (!olderThan(version, newest)) {
        add("ok", "package.update", `sentinel-ir-mcp ${version} is newer than npm's ${tag} (${newest})`);
        return;
    }
    const spec = `sentinel-ir-mcp@${tag}`;
    const globals = globalDirs(io.env, io.platform, io.execPath || process.execPath).flatMap((g) => [g, realDir(g)]);
    const from = installKind(io.packageDir || PACKAGE_DIR, globals);
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

// A global install other than this copy that is older or runs an old sentinel-ir:
// bare `npx sentinel-ir-mcp` and client entries without a version start it.
function checkGlobalInstall(io, add) {
    const running = io.packageDir || PACKAGE_DIR;
    for (const dir of globalDirs(io.env, io.platform, io.execPath || process.execPath)) {
        if (sameDir(dir, running) || sameDir(realDir(dir), realDir(running)) || !fs.existsSync(path.join(dir, "package.json"))) continue;
        const mcp = readVersion(path.join(dir, "package.json"));
        const ir = readVersion(path.join(dir, "node_modules", "sentinel-ir", "package.json"));
        if (!olderThan(mcp, version) && !olderThan(ir, IR_MIN)) continue;
        add("warn", "package.global", `A global install of sentinel-ir-mcp ${mcp} (sentinel-ir ${ir}) is at ${dir}; bare npx sentinel-ir-mcp and client entries without a version start it`,
            `Run: npm install -g ${PACKAGE_SPEC} (or npm uninstall -g sentinel-ir-mcp)`);
    }
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
    checkGlobalInstall(io, add);
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

module.exports = { runDoctor, entryFolders, olderThan, staleNpxCopies, fetchDistTags, proxyFor, installKind, globalDirs, IR_MIN };
