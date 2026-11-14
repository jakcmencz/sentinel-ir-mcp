"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCommand } = require("../src/cli");
const http = require("http");
const https = require("https");
const { entryFolders, fetchDistTags, installKind, proxyFor, globalDirs, IR_MIN } = require("../src/doctor");
const { version } = require("../package.json");

function sandbox() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-doctor-")));
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "run.js"), 'require("child_process").exec("ls");\n');
    return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function run(sb, command, argv, extra = {}) {
    let stdout = "";
    let stderr = "";
    const io = {
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
        env: { HOME: sb.home, ...(extra.env || {}) }, platform: extra.platform || "linux", cwd: extra.cwd || sb.project, isTTY: false, prompt: null,
        now: () => Date.UTC(2026, 9, 18), nodeVersion: extra.nodeVersion, execPath: path.join(sb.base, "node", "bin", "node"),
        ...(extra.io || {})
    };
    const code = await runCommand(command, argv, io);
    return { code, stdout, stderr };
}

const doctorJson = async (sb, argv, extra) => {
    const r = await run(sb, "doctor", [...argv, "--json"], extra);
    return { code: r.code, report: JSON.parse(r.stdout) };
};
const byId = (report, id) => report.checks.filter((c) => c.id === id);

test("doctor after setup: real handshake, exactly three tools, analyze_directory call, exit 0", async () => {
    const sb = sandbox();
    try {
        assert.equal((await run(sb, "setup", ["--client", "windsurf", "--yes"])).code, 0);
        const { code, report } = await doctorJson(sb, ["--client", "windsurf"], { cwd: sb.base });
        assert.equal(code, 0, JSON.stringify(report, null, 2));
        assert.equal(report.ok, true);
        assert.equal(byId(report, "node")[0].status, "ok");
        assert.match(byId(report, "windsurf.entry")[0].message, /sentinel-ir-mcp@stable-0\.5/);
        assert.equal(byId(report, "mcp.handshake")[0].status, "ok");
        assert.equal(byId(report, "mcp.tools")[0].message, "Tools: analyze_code, analyze_directory, analyze_file");
        assert.ok(byId(report, "mcp.call")[0].message.includes(sb.project), "uses the folder from the config, not the cwd");
    } finally { sb.cleanup(); }
});

test("doctor resolves ${workspaceFolder} in a Cursor project config", async () => {
    const sb = sandbox();
    try {
        assert.equal((await run(sb, "setup", ["--client", "cursor", "--yes"])).code, 0);
        const { code, report } = await doctorJson(sb, ["--client", "cursor"]);
        assert.equal(code, 0, JSON.stringify(report, null, 2));
        assert.ok(byId(report, "mcp.call")[0].message.includes(sb.project));
    } finally { sb.cleanup(); }
});

test("doctor exits 1 with a fix for a missing config, a missing entry, invalid JSON, a wrong entry or a missing folder", async () => {
    const sb = sandbox();
    try {
        const file = path.join(sb.home, ".config", "devin", "mcp_config.json");
        const expectFail = async (id, pattern) => {
            const { code, report } = await doctorJson(sb, ["--client", "windsurf"]);
            assert.equal(code, 1, id);
            const failed = report.checks.filter((c) => c.status === "fail");
            assert.ok(failed.some((c) => c.id === id && pattern.test(c.message) && c.fix), `${id}: ${JSON.stringify(failed)}`);
        };
        await expectFail("windsurf.config", /not found/);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{"mcpServers": {"other": {"command": "x"}}}');
        await expectFail("windsurf.entry", /no "sentinel-ir"/);
        fs.writeFileSync(file, "{ nope");
        await expectFail("windsurf.config", /not valid JSON/);
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "rm", args: ["-rf", "/"] } } }));
        await expectFail("windsurf.entry", /does not start sentinel-ir-mcp/);
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp@stable-0.5", path.join(sb.base, "gone")] } } }));
        await expectFail("windsurf.folder", /does not exist/);
    } finally { sb.cleanup(); }
});

test("doctor never runs the command stored in the client config", async () => {
    const sb = sandbox();
    try {
        const marker = path.join(sb.base, "ran");
        const file = path.join(sb.home, ".config", "devin", "mcp_config.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const evil = path.join(sb.base, "evil.js");
        fs.writeFileSync(evil, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: process.execPath, args: [evil, "sentinel-ir-mcp", sb.project] } } }));
        const { code, report } = await doctorJson(sb, ["--client", "windsurf"]);
        assert.equal(byId(report, "windsurf.entry")[0].status, "warn");
        assert.equal(code, 0, "own server still answers");
        assert.equal(fs.existsSync(marker), false);
    } finally { sb.cleanup(); }
});

test("doctor without a client checks configs it finds and the project folder; text output", async () => {
    const sb = sandbox();
    try {
        const r = await run(sb, "doctor", []);
        assert.equal(r.code, 0, r.stdout);
        assert.match(r.stdout, /\[skip\] Windsurf: no config/);
        assert.match(r.stdout, /\[ok\] {3}Tools: analyze_code, analyze_directory, analyze_file/);
        assert.match(r.stdout, /All checks passed/);
        const missing = await run(sb, "doctor", ["--project", path.join(sb.base, "nope")]);
        assert.equal(missing.code, 1);
        assert.match(missing.stdout, /\[FAIL\] Project folder/);
    } finally { sb.cleanup(); }
});

test("entryFolders skips flags and their values", () => {
    assert.deepEqual(entryFolders(["-y", "sentinel-ir-mcp@stable-0.5", "--max-files", "5", "/a", "--max-file-bytes=9", "/b"]), ["/a", "/b"]);
    assert.deepEqual(entryFolders(["-y", "sentinel-ir-mcp"]), []);
    assert.equal(entryFolders(["-y", "other-server"]), null);
});

test("doctor fails with exit 1 on Node.js older than 20", async () => {
    const sb = sandbox();
    try {
        const { code, report } = await doctorJson(sb, [], { nodeVersion: "18.19.0" });
        assert.equal(code, 1);
        assert.deepEqual(byId(report, "node")[0], { status: "fail", id: "node", message: "Node.js v18.19.0 is too old", fix: "Install Node.js 20 or newer." });
    } finally { sb.cleanup(); }
});

test("doctor on Windows (simulated): cmd /c npx is ok, plain npx gets a warning", async () => {
    const sb = sandbox();
    try {
        const appdata = path.join(sb.base, "AppData", "Roaming");
        const file = path.join(appdata, "Claude", "claude_desktop_config.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const win = { platform: "win32", env: { APPDATA: appdata } };
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "cmd", args: ["/c", "npx", "-y", "sentinel-ir-mcp@stable-0.5", sb.project] } } }));
        let { code, report } = await doctorJson(sb, ["--client", "claude-desktop"], win);
        assert.equal(code, 0);
        assert.equal(byId(report, "claude-desktop.entry")[0].status, "ok");
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp@stable-0.5", sb.project] } } }));
        ({ code, report } = await doctorJson(sb, ["--client", "claude-desktop"], win));
        assert.equal(code, 0);
        assert.equal(byId(report, "claude-desktop.entry")[0].status, "warn");
        assert.match(byId(report, "claude-desktop.entry")[0].fix, /setup --client claude-desktop/);
    } finally { sb.cleanup(); }
});

test("doctor reads an old ~/.codeium Windsurf config and warns that it moved", async () => {
    const sb = sandbox();
    try {
        const legacy = path.join(sb.home, ".codeium", "windsurf", "mcp_config.json");
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp@stable-0.5", sb.project] } } }));
        const { code, report } = await doctorJson(sb, ["--client", "windsurf"]);
        assert.equal(code, 0);
        assert.equal(byId(report, "windsurf.location")[0].status, "warn");
        assert.match(byId(report, "windsurf.location")[0].fix, /\.config.devin.mcp_config\.json/);
        assert.equal(byId(report, "windsurf.entry")[0].status, "ok");
    } finally { sb.cleanup(); }
});

test("doctor warns about entries pinned to a version or range and accepts the stable tag", async () => {
    const sb = sandbox();
    try {
        const file = path.join(sb.home, ".cursor", "mcp.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const rust = /without Rust support/;
        const cached = /keeps starting the copy it downloaded first/;
        for (const [spec, status, why] of [
            ["sentinel-ir-mcp@0.2", "warn", rust], ["sentinel-ir-mcp@0.3", "warn", rust], ["sentinel-ir-mcp@0.3.0", "warn", rust],
            ["sentinel-ir-mcp@0.4", "warn", rust], ["sentinel-ir-mcp@0.4.6", "warn", rust], ["sentinel-ir-mcp@^0.4.0", "warn", rust],
            ["sentinel-ir-mcp@0.5", "warn", cached], ["sentinel-ir-mcp@0.5.0", "warn", cached], ["sentinel-ir-mcp@~0.5.1", "warn", cached],
            ["sentinel-ir-mcp@>=0.5.0", "warn", cached], ["sentinel-ir-mcp@1", "warn", cached],
            ["sentinel-ir-mcp@stable-0.5", "ok"], ["sentinel-ir-mcp@latest", "ok"], ["sentinel-ir-mcp", "ok"]]) {
            fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", spec, sb.project] } } }));
            const { report } = await doctorJson(sb, ["--client", "cursor", "--global"]);
            const entry = byId(report, "cursor.entry")[0];
            assert.equal(entry.status, status, spec);
            if (status === "warn") {
                assert.match(entry.fix, why, spec);
                assert.match(entry.fix, /sentinel-ir-mcp@stable-0\.5 setup --client cursor/);
            }
        }
    } finally { sb.cleanup(); }
});

test("doctor: setup writes the stable-<major>.<minor> tag of this release", () => {
    const { version } = require("../package.json");
    const { PACKAGE_SPEC, STABLE_TAG } = require("../src/clients");
    assert.equal(STABLE_TAG, `stable-${version.split(".").slice(0, 2).join(".")}`);
    assert.equal(PACKAGE_SPEC, `sentinel-ir-mcp@${STABLE_TAG}`);
});

test("doctor: the loaded sentinel-ir meets the dependency floor", async () => {
    const sb = sandbox();
    try {
        const { IR_MIN } = require("../src/doctor");
        assert.equal(`^${IR_MIN}`, require("../package.json").dependencies["sentinel-ir"]);
        const { report } = await doctorJson(sb, []);
        const pkg = byId(report, "package")[0];
        assert.equal(pkg.status, "ok");
        assert.match(pkg.message, new RegExp(`sentinel-ir ${require("sentinel-ir/package.json").version.replace(/\./g, "\\.")}$`));
    } finally { sb.cleanup(); }
});

test("doctor: olderThan compares numerically and treats unknown as older", () => {
    const { olderThan } = require("../src/doctor");
    for (const [a, b, want] of [["0.5.2", "0.5.6", true], ["0.5.6", "0.5.6", false], ["0.5.10", "0.5.6", false], ["0.4.99", "0.5.6", true],
        ["1.0.0", "0.5.6", false], ["0.5.7-rc.1", "0.5.6", false], ["unknown", "0.5.6", true], ["", "0.5.6", true], [undefined, "0.5.6", true]]) {
        assert.equal(olderThan(a, b), want, `${a} < ${b}`);
    }
});

function fakeNpxCopy(cache, key, spec, mcp, ir, { npx = true } = {}) {
    const dir = path.join(cache, "_npx", key);
    const mod = path.join(dir, "node_modules");
    fs.mkdirSync(path.join(mod, "sentinel-ir-mcp"), { recursive: true });
    fs.writeFileSync(path.join(mod, "sentinel-ir-mcp", "package.json"), JSON.stringify({ name: "sentinel-ir-mcp", version: mcp }));
    if (ir !== null) {
        fs.mkdirSync(path.join(mod, "sentinel-ir"), { recursive: true });
        fs.writeFileSync(path.join(mod, "sentinel-ir", "package.json"), ir === "junk" ? "{nope" : JSON.stringify({ name: "sentinel-ir", version: ir }));
    }
    const range = spec.slice("sentinel-ir-mcp@".length);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(npx
        ? { dependencies: { "sentinel-ir-mcp": `^${range}` }, _npx: { packages: [spec] } }
        : { dependencies: { "sentinel-ir-mcp": range } }));
    return dir;
}

test("doctor warns about npx-cached copies whose sentinel-ir is too old and names the folder", async () => {
    const sb = sandbox();
    try {
        const cache = path.join(sb.base, "npm-cache");
        const stale = fakeNpxCopy(cache, "aaa1", "sentinel-ir-mcp@0.5", "0.5.0", "0.5.2");
        const oldLine = fakeNpxCopy(cache, "bbb2", "sentinel-ir-mcp@0.2", "0.2.3", "0.2.1", { npx: false });
        const missing = fakeNpxCopy(cache, "ccc3", "sentinel-ir-mcp@0.5", "0.5.0", null);
        const broken = fakeNpxCopy(cache, "ddd4", "sentinel-ir-mcp@0.5", "0.5.0", "junk");
        fakeNpxCopy(cache, "eee5", "sentinel-ir-mcp@stable-0.5", "0.5.1", "0.5.6");
        fakeNpxCopy(cache, "fff6", "sentinel-ir-mcp@stable-0.5", "0.5.9", "0.6.0");
        fs.mkdirSync(path.join(cache, "_npx", "ggg7", "node_modules", "other"), { recursive: true });
        fs.writeFileSync(path.join(cache, "_npx", "not-a-folder"), "x");
        const { report, code } = await doctorJson(sb, [], { env: { npm_config_cache: cache } });
        const warns = byId(report, "npx.cache");
        assert.deepEqual(warns.map((c) => c.status), ["warn", "warn", "warn", "warn"]);
        assert.match(warns[0].message, /cached sentinel-ir-mcp@0\.5 \(sentinel-ir-mcp 0\.5\.0, sentinel-ir 0\.5\.2\)/);
        assert.ok(warns[0].message.includes(stale));
        assert.match(warns[0].fix, /npm cache npx rm aaa1\), then run: npx -y sentinel-ir-mcp@stable-0\.5 setup$/);
        assert.match(warns[1].message, /cached sentinel-ir-mcp@0\.2 \(sentinel-ir-mcp 0\.2\.3, sentinel-ir 0\.2\.1\)/);
        assert.ok(warns[1].message.includes(oldLine));
        assert.ok(warns[2].message.includes(missing) && /sentinel-ir unknown/.test(warns[2].message));
        assert.ok(warns[3].message.includes(broken) && /sentinel-ir unknown/.test(warns[3].message));
        assert.equal(code, 0, "a stale cache is a warning, not a failure");
    } finally { sb.cleanup(); }
});

test("doctor: the npx cache check reads the sentinel-ir the server loads, nested or top-level", async () => {
    const sb = sandbox();
    try {
        const cache = path.join(sb.base, "npm-cache");
        const nest = (dir, v) => {
            const d = path.join(dir, "node_modules", "sentinel-ir-mcp", "node_modules", "sentinel-ir");
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "sentinel-ir", version: v }));
        };
        const healthy = fakeNpxCopy(cache, "aaa1", "sentinel-ir-mcp@stable-0.5", "0.5.1", "0.4.0");
        nest(healthy, "0.5.6");
        const stale = fakeNpxCopy(cache, "bbb2", "sentinel-ir-mcp@0.5", "0.5.0", "0.6.0");
        nest(stale, "0.5.2");
        const { report } = await doctorJson(sb, [], { env: { npm_config_cache: cache } });
        const warns = byId(report, "npx.cache");
        assert.equal(warns.length, 1);
        assert.ok(warns[0].message.includes(stale) && /sentinel-ir 0\.5\.2\)/.test(warns[0].message), warns[0].message);
    } finally { sb.cleanup(); }
});

test("doctor: an empty or missing npx cache is ok", async () => {
    const sb = sandbox();
    try {
        for (const cache of [path.join(sb.base, "none"), sb.base]) {
            const { report } = await doctorJson(sb, [], { env: { npm_config_cache: cache } });
            assert.deepEqual(byId(report, "npx.cache").map((c) => c.status), ["ok"]);
        }
        const { report } = await doctorJson(sb, [], { platform: "win32", env: { LOCALAPPDATA: path.join(sb.base, "Local") } });
        assert.ok(byId(report, "npx.cache")[0].message.includes(path.join(sb.base, "Local", "npm-cache", "_npx")));
    } finally { sb.cleanup(); }
});

const STABLE = `stable-${version.split(".").slice(0, 2).join(".")}`;
const newerTags = async () => ({ [STABLE]: `${version.split(".").slice(0, 2).join(".")}.999`, latest: "9.0.0" });

test("doctor warns when npm has a newer stable release and says where this copy runs from", async () => {
    const sb = sandbox();
    try {
        const npxDir = path.join(sb.home, ".npm", "_npx", "abc123def4567890", "node_modules", "sentinel-ir-mcp");
        const cases = [
            [npxDir, /the npx cache \(.*abc123def4567890\)/, /npm cache npx rm abc123def4567890\), then run: npx -y sentinel-ir-mcp@stable-/],
            ["/usr/lib/node_modules/sentinel-ir-mcp", /a global install/, /npm install -g sentinel-ir-mcp@stable-/],
            ["C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\sentinel-ir-mcp", /a global install/, /npm install -g/],
            [path.join(sb.project, "node_modules", "sentinel-ir-mcp"), /runs from .*project/, /Run the current version: npx -y sentinel-ir-mcp@stable-/]
        ];
        for (const [packageDir, where, fix] of cases) {
            const { code, report } = await doctorJson(sb, [], { io: { fetchDistTags: newerTags, packageDir } });
            const [c] = byId(report, "package.update");
            assert.equal(c.status, "warn", packageDir);
            assert.match(c.message, new RegExp(`This is sentinel-ir-mcp ${version.replace(/\./g, "\\.")}, npm has .*\\.999 \\(${STABLE}\\)`));
            assert.match(c.message, where, packageDir);
            assert.match(c.fix, fix, packageDir);
            assert.equal(code, 0, "a newer release is a warning, not a failure");
        }
    } finally { sb.cleanup(); }
});

test("doctor: current, offline, missing tag and no update check", async () => {
    const sb = sandbox();
    try {
        const status = async (fetch) => byId((await doctorJson(sb, [], { io: fetch ? { fetchDistTags: fetch } : {} })).report, "package.update").map((c) => [c.status, c.message]);
        assert.deepEqual(await status(async () => ({ [STABLE]: version })), [["ok", `sentinel-ir-mcp ${version} is the newest ${STABLE} on npm`]]);
        assert.deepEqual(await status(async () => ({ [STABLE]: "0.0.1" })), [["ok", `sentinel-ir-mcp ${version} is newer than npm's ${STABLE} (0.0.1)`]]);
        assert.match((await status(async () => null))[0].join(" "), /^skip No usable answer from the npm registry/);
        assert.match((await status(async () => ({ latest: "9.9.9" })))[0].join(" "), /^skip npm has no stable-/);
        assert.match((await status(async () => JSON.parse('{"__proto__":{"stable-0.5":"9.9.9"}}')))[0].join(" "), /^skip npm has no stable-/);
        assert.deepEqual(await status(async () => ({ [STABLE]: "0.5.5-beta.1" })), [["skip", `npm's ${STABLE} tag points to "0.5.5-beta.1", not a release version; no update check`]]);
        const [[st, msg]] = await status(async () => ({ [STABLE]: "0.5.9\u001b[2J\nAll checks passed." + "x".repeat(100) }));
        assert.equal(st, "skip");
        assert.ok(!/[\u0000-\u001f]/.test(msg), "control characters from the registry are escaped");
        assert.match(msg, /\.\.\., not a release version/);
        assert.match((await status(async () => ({ [STABLE]: "0.05.06" })))[0][1], /not a release version/, "npm never publishes leading zeros");
        assert.match((await status(async () => ({ [STABLE]: 5 })))[0][1], /points to 5, not a release/);
        assert.deepEqual(await status(null), [], "tests and embedders without fetchDistTags stay offline");
    } finally { sb.cleanup(); }
});

test("doctor summary counts warnings", async () => {
    const sb = sandbox();
    try {
        const r = await run(sb, "doctor", [], { io: { fetchDistTags: newerTags, packageDir: "/usr/lib/node_modules/sentinel-ir-mcp" } });
        assert.equal(r.code, 0);
        assert.match(r.stdout, /\nAll checks passed, \d+ warnings? above\.\n$/);
        const ok = await run(sb, "doctor", []);
        assert.match(ok.stdout, /\nAll checks passed\.\n$/);
    } finally { sb.cleanup(); }
});

test("installKind tells npx copies, global installs and other folders apart", () => {
    assert.equal(installKind("/home/a/.npm/_npx/0123abcd/node_modules/sentinel-ir-mcp").kind, "npx");
    assert.equal(installKind("/home/a/.npm/_npx/0123abcd/node_modules/sentinel-ir-mcp").key, "0123abcd");
    assert.equal(installKind("C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\0123abcd\\node_modules\\sentinel-ir-mcp").key, "0123abcd");
    assert.equal(installKind("/usr/local/lib/node_modules/sentinel-ir-mcp").kind, "global");
    assert.equal(installKind("/data/data/com.termux/files/usr/lib/node_modules/sentinel-ir-mcp").kind, "global");
    assert.equal(installKind("/home/a/proj/node_modules/sentinel-ir-mcp").kind, "other");
});

test("doctor finds an old global install that bare npx starts, also under a Windows prefix without lib", async () => {
    const sb = sandbox();
    try {
        const put = (dir, mcp, ir) => {
            fs.mkdirSync(path.join(dir, "node_modules", "sentinel-ir"), { recursive: true });
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: mcp }));
            fs.writeFileSync(path.join(dir, "node_modules", "sentinel-ir", "package.json"), JSON.stringify({ version: ir }));
        };
        const prefix = path.join(sb.base, "prefix");
        put(path.join(prefix, "lib", "node_modules", "sentinel-ir-mcp"), "0.3.0", "0.3.1");
        const { code, report } = await doctorJson(sb, [], { env: { npm_config_prefix: prefix } });
        const [g] = byId(report, "package.global");
        assert.equal(g.status, "warn");
        assert.match(g.message, /sentinel-ir-mcp 0\.3\.0 \(sentinel-ir 0\.3\.1\) is at .*prefix/);
        assert.match(g.fix, /npm install -g sentinel-ir-mcp@stable-/);
        assert.equal(code, 0);
        put(path.join(prefix, "lib", "node_modules", "sentinel-ir-mcp"), version, IR_MIN);
        assert.deepEqual(byId((await doctorJson(sb, [], { env: { npm_config_prefix: prefix } })).report, "package.global"), [], "current global copy");
        assert.deepEqual(byId((await doctorJson(sb, [])).report, "package.global"), [], "no global copy");
        const nvm = "C:\\nvm4w\\nodejs";
        assert.equal(installKind(`${nvm}\\node_modules\\sentinel-ir-mcp`, globalDirs({}, "win32", `${nvm}\\node.exe`)).kind, "global");
        assert.deepEqual(globalDirs({ APPDATA: "C:\\U\\AppData\\Roaming" }, "win32", `${nvm}\\node.exe`),
            ["C:\\U\\AppData\\Roaming\\npm\\node_modules\\sentinel-ir-mcp", `${nvm}\\node_modules\\sentinel-ir-mcp`]);
        assert.deepEqual(globalDirs({}, "linux", "/usr/bin/node"), ["/usr/lib/node_modules/sentinel-ir-mcp"]);
        const linked = path.join(sb.base, "linked");
        fs.mkdirSync(linked);
        fs.rmSync(path.join(prefix, "lib", "node_modules", "sentinel-ir-mcp"), { recursive: true });
        fs.symlinkSync(linked, path.join(prefix, "lib", "node_modules", "sentinel-ir-mcp"), "junction");
        const { report: r2 } = await doctorJson(sb, [], { env: { npm_config_prefix: prefix }, io: { fetchDistTags: newerTags, packageDir: linked } });
        assert.match(byId(r2, "package.update")[0].message, /a global install/, "npm link / npm i -g <folder>");
    } finally { sb.cleanup(); }
});

test("proxyFor: NO_PROXY with IPv6, ports and trailing dots; unusable proxies are not bypassed", () => {
    const P = "http://p:3128";
    const via = (u, env) => proxyFor(new URL(u), { HTTPS_PROXY: P, HTTP_PROXY: P, ...env });
    for (const rule of ["::1", "[::1]", "[::1]:443"]) assert.equal(via("https://[::1]/", { NO_PROXY: rule }), null, rule);
    assert.equal(via("https://registry.npmjs.org./", { NO_PROXY: "npmjs.org" }), null);
    assert.equal(via("https://registry.npmjs.org/", { NO_PROXY: "registry.npmjs.org.:443" }), null);
    assert.equal(via("https://registry.npmjs.org/", { NO_PROXY: "example.com" }).href, "http://p:3128/");
    assert.equal(via("https://[::2]/", { NO_PROXY: "::1" }).href, "http://p:3128/");
    for (const bad of ["socks5://p:1080", "http://[bad"]) assert.equal(via("https://registry.npmjs.org/", { HTTPS_PROXY: bad }), false, bad);
    assert.equal(proxyFor(new URL("https://registry.npmjs.org/"), {}), null);
    assert.equal(proxyFor(new URL("http://registry.internal/"), { HTTPS_PROXY: P }).href, "http://p:3128/", "npm uses https-proxy for http registries too");
    for (const u of ["http://registry.internal/", "https://registry.npmjs.org/"]) {
        assert.equal(proxyFor(new URL(u), { npm_config_proxy: P, HTTPS_PROXY: "http://env:1" }).href, "http://p:3128/", `npm's proxy setting before HTTPS_PROXY: ${u}`);
    }
});

test("fetchDistTags reads the registry from npm_config_registry and gives up on bad answers", async () => {
    let mode = "ok";
    const server = http.createServer((req, res) => {
        if (mode === "slow") return; // never answers
        if (mode === "500") { res.writeHead(500); return res.end("{}"); }
        if (mode === "junk") { res.writeHead(200); return res.end("not json"); }
        if (mode === "wide") { res.writeHead(200); return res.end(JSON.stringify({ latest: "0.5.3", pad: "č".repeat(40000) })); }
        if (mode === "huge") { res.writeHead(200); return res.end(JSON.stringify({ latest: "0.5.3", pad: "x".repeat(70000) })); }
        assert.equal(req.url, "/npm/-/package/sentinel-ir-mcp/dist-tags");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ latest: "0.5.3", "stable-0.5": "0.5.3" }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const env = { npm_config_registry: `http://127.0.0.1:${server.address().port}/npm` };
    try {
        assert.deepEqual(await fetchDistTags(env), { latest: "0.5.3", "stable-0.5": "0.5.3" });
        for (mode of ["500", "junk", "huge", "wide"]) assert.equal(await fetchDistTags(env), null, mode);
        mode = "slow";
        const t0 = Date.now();
        assert.equal(await fetchDistTags(env, 300), null);
        assert.ok(Date.now() - t0 < 2000);
        assert.equal(await fetchDistTags({ npm_config_registry: "ftp://x/" }), null);
        assert.equal(await fetchDistTags({ npm_config_registry: "::bad::" }), null);
        assert.equal(await fetchDistTags({ npm_config_registry: "http://127.0.0.1:1/" }), null);
    } finally { server.closeAllConnections(); server.close(); }
});

function tlsCert() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sir-tls-"));
    try {
        require("child_process").execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
        return { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) };
    } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const TAGS = { latest: "0.5.3", "stable-0.5": "0.5.3" };
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const stop = (...servers) => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } };

test("fetchDistTags follows up to 3 redirects, never from https to http", async () => {
    const server = http.createServer((req, res) => {
        const n = +(/\/hop(\d+)\//.exec(req.url) || [0, 0])[1];
        if (req.url.startsWith("/hop")) { res.writeHead(n % 2 ? 302 : 301, { location: n > 1 ? `/hop${n - 1}/x` : "/npm/-/package/sentinel-ir-mcp/dist-tags" }); return res.end(); }
        if (req.url === "/abs/-/package/sentinel-ir-mcp/dist-tags") { res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/npm/-/package/sentinel-ir-mcp/dist-tags` }); return res.end(); }
        if (req.url === "/ftp/-/package/sentinel-ir-mcp/dist-tags") { res.writeHead(302, { location: "ftp://127.0.0.1/" }); return res.end(); }
        if (req.url === "/npm/-/package/sentinel-ir-mcp/dist-tags") { res.writeHead(200); return res.end(JSON.stringify(TAGS)); }
        if (req.url === "/open/-/package/sentinel-ir-mcp/dist-tags") { res.writeHead(302, { location: "/hang" }); return res.write("x"); }
        if (req.url === "/hang") return;
        res.writeHead(404); res.end();
    });
    let live = 0;
    server.on("connection", (s) => { live++; s.on("close", () => live--); });
    const port = await listen(server);
    try {
        const at = (p) => fetchDistTags({ npm_config_registry: `http://127.0.0.1:${port}/${p}` });
        assert.deepEqual(await at("abs/"), TAGS);
        assert.deepEqual(await at("hop3/"), TAGS, "3 redirects");
        assert.equal(await at("hop4/"), null, "4 redirects");
        assert.equal(await at("ftp/"), null);
        assert.equal(await fetchDistTags({ npm_config_registry: `http://127.0.0.1:${port}/open/` }, 300), null);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(live, 0, "timeout closes the redirect response and the next request");
        const cert = tlsCert();
        if (cert) {
            const tlsServer = https.createServer(cert, (req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${port}/npm/-/package/sentinel-ir-mcp/dist-tags` }); res.end(); });
            const tport = await listen(tlsServer);
            try { assert.equal(await fetchDistTags({ npm_config_registry: `https://127.0.0.1:${tport}/` }, 3000, { ca: cert.cert }), null); } finally { stop(tlsServer); }
        }
    } finally { stop(server); }
});

test("fetchDistTags goes through the proxy npm would use", async () => {
    const seen = [];
    let lastAuth;
    const registry = http.createServer((req, res) => { lastAuth = req.headers.authorization; res.writeHead(200); res.end(JSON.stringify(TAGS)); });
    const rport = await listen(registry);
    const cert = tlsCert();
    const tlsRegistry = cert && https.createServer(cert, (req, res) => { if (req.url.startsWith("/hang/")) return; res.writeHead(200); res.end(JSON.stringify({ ...TAGS, tls: "1" })); });
    const tport = tlsRegistry && await listen(tlsRegistry);
    const proxy = http.createServer((req, res) => {
        seen.push(["GET", req.url, req.headers["proxy-authorization"] || ""]);
        if (req.url.includes("deny")) { res.writeHead(407); return res.end(); }
        const u = new URL(req.url);
        http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { authorization: req.headers.authorization || "" } }, (r) => { res.writeHead(r.statusCode); r.pipe(res); });
    });
    let tunnels = 0;
    proxy.on("connect", (req, socket) => {
        if (req.url === "localhost:2") { tunnels++; socket.on("close", () => tunnels--); }
        seen.push(["CONNECT", req.url, req.headers["proxy-authorization"] || ""]);
        if (req.url.startsWith("deny")) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
        const [host, port] = /^(localhost|127\.0\.0\.[12]):[12]$/.test(req.url) ? ["localhost", tport] : req.url.split(":");
        const up = require("net").connect(+port, host === "localhost" ? "127.0.0.1" : host, () => { socket.write("HTTP/1.1 200 OK\r\n\r\n"); up.pipe(socket); socket.pipe(up); });
        up.on("error", () => socket.destroy());
    });
    const pport = await listen(proxy);
    const P = `http://127.0.0.1:${pport}`;
    try {
        const reg = `http://127.0.0.1:${rport}/`;
        assert.deepEqual(await fetchDistTags({ npm_config_registry: reg, HTTP_PROXY: P }), TAGS);
        assert.deepEqual(seen.pop(), ["GET", `${reg}-/package/sentinel-ir-mcp/dist-tags`, ""]);
        assert.deepEqual(await fetchDistTags({ npm_config_registry: reg, npm_config_proxy: `http://u%40x:p%3Aw@127.0.0.1:${pport}`, HTTP_PROXY: "http://127.0.0.1:1" }), TAGS);
        assert.equal(seen.pop()[2], "Basic " + Buffer.from("u@x:p:w").toString("base64"), "npm config wins, credentials decoded");
        assert.deepEqual(await fetchDistTags({ npm_config_registry: reg, http_proxy: `127.0.0.1:${pport}` }), TAGS, "proxy without a scheme");
        assert.deepEqual(await fetchDistTags({ npm_config_registry: `http://tok:s%40cret@127.0.0.1:${rport}/`, HTTP_PROXY: P }), TAGS);
        assert.deepEqual(seen.pop(), ["GET", `${reg}-/package/sentinel-ir-mcp/dist-tags`, ""], "registry login is not in the proxied request line");
        assert.equal(lastAuth, "Basic " + Buffer.from("tok:s@cret").toString("base64"), "registry login sent as Authorization");
        assert.deepEqual(await fetchDistTags({ npm_config_registry: `http://tok:50%@127.0.0.1:${rport}/`, HTTP_PROXY: `http://u:1%zz@127.0.0.1:${pport}` }), TAGS, "a literal % in a login");
        assert.equal(lastAuth, "Basic " + Buffer.from("tok:50%").toString("base64"));
        assert.deepEqual(await fetchDistTags({ npm_config_registry: `http://u:p%zz@127.0.0.1:${rport}/` }), TAGS, "a malformed % in a direct registry login");
        assert.equal(lastAuth, "Basic " + Buffer.from("u:p%zz").toString("base64"));
        await fetchDistTags({ npm_config_registry: `http://:tok@127.0.0.1:${rport}/` });
        assert.equal(lastAuth, "Basic " + Buffer.from(":tok").toString("base64"), "password-only login");
        seen.length = 0;
        assert.deepEqual(await fetchDistTags({ npm_config_registry: reg, HTTP_PROXY: P, NO_PROXY: "example.com, 127.0.0.1" }), TAGS);
        assert.deepEqual(await fetchDistTags({ npm_config_registry: reg, HTTP_PROXY: P, no_proxy: "*" }), TAGS);
        assert.deepEqual(await fetchDistTags({ npm_config_registry: reg, HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1", npm_config_noproxy: "" }), TAGS, "npx exports npm_config_noproxy=\"\"");
        assert.deepEqual(seen, [], "NO_PROXY bypasses the proxy");
        assert.equal(await fetchDistTags({ npm_config_registry: `http://127.0.0.1:${rport}/deny/`, HTTP_PROXY: P }), null, "407");
        assert.equal(await fetchDistTags({ npm_config_registry: reg, HTTP_PROXY: "http://127.0.0.1:1" }), null, "proxy down");
        if (cert) {
            const treg = `https://localhost:${tport}/`;
            assert.deepEqual(await fetchDistTags({ npm_config_registry: treg, HTTPS_PROXY: P, HTTP_PROXY: "http://127.0.0.1:1" }, 3000, { ca: cert.cert }), { ...TAGS, tls: "1" });
            assert.deepEqual(seen.pop(), ["CONNECT", `localhost:${tport}`, ""]);
            assert.deepEqual(await fetchDistTags({ npm_config_registry: "https://localhost:1/", HTTPS_PROXY: P }, 3000, { ca: cert.cert }), { ...TAGS, tls: "1" }, "request goes through the tunnel, not direct");
            assert.deepEqual(await fetchDistTags({ npm_config_registry: "https://127.0.0.1:1/", HTTPS_PROXY: P }, 3000, { ca: cert.cert }), { ...TAGS, tls: "1" }, "IP registry checked against its IP");
            assert.equal(await fetchDistTags({ npm_config_registry: "https://127.0.0.2:1/", HTTPS_PROXY: P }, 3000, { ca: cert.cert }), null, "certificate for localhost does not pass for 127.0.0.2");
            assert.deepEqual(await fetchDistTags({ npm_config_registry: treg, HTTP_PROXY: P }, 3000, { ca: cert.cert }), { ...TAGS, tls: "1" }, "https falls back to HTTP_PROXY");
            assert.equal(await fetchDistTags({ npm_config_registry: treg, HTTPS_PROXY: P }), null, "certificate still checked through the tunnel");
            assert.deepEqual(await fetchDistTags({ npm_config_registry: `https://u:p%zz@localhost:${tport}/`, HTTPS_PROXY: P }, 3000, { ca: cert.cert }), { ...TAGS, tls: "1" }, "malformed % in an https login through the tunnel");
            const cafile = path.join(os.tmpdir(), `sir-ca-${process.pid}.pem`);
            fs.writeFileSync(cafile, cert.cert);
            try {
                assert.deepEqual(await fetchDistTags({ npm_config_registry: treg, npm_config_cafile: cafile }), { ...TAGS, tls: "1" }, "npm cafile");
                assert.deepEqual(await fetchDistTags({ npm_config_registry: treg, npm_config_strict_ssl: "false" }), { ...TAGS, tls: "1" }, "npm strict-ssl=false");
                assert.equal(await fetchDistTags({ npm_config_registry: reg, npm_config_cafile: cafile + ".missing" }), null, "unreadable cafile: npm fails too");
            } finally { fs.rmSync(cafile, { force: true }); }
            assert.equal(await fetchDistTags({ npm_config_registry: `https://deny:${tport}/`, HTTPS_PROXY: P }), null, "CONNECT refused");
            assert.equal(await fetchDistTags({ npm_config_registry: "https://localhost:2/hang/", HTTPS_PROXY: P }, 300, { ca: cert.cert }), null);
            await new Promise((r) => setTimeout(r, 100));
            assert.equal(tunnels, 0, "timeout closes the tunneled request");
        }
    } finally { stop(registry, proxy, ...(tlsRegistry ? [tlsRegistry] : [])); }
});
