"use strict";

// Fixes from the 0.5.21 user test on Linux, macOS and Windows.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = require("../src/server");
const { runCommand } = require("../src/cli");
const { npmPolicy } = require("../src/doctor");
const { BIN, makeFixture, call } = require("./helpers");

async function connect(options) {
    const server = createServer(options);
    const client = new Client({ name: "v0522", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
}

function sandbox() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-v0522-")));
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "run.js"), "module.exports = 1;\n");
    return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function run(sb, command, argv, io = {}) {
    let stdout = "";
    const code = await runCommand(command, argv, {
        stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stdout += s; } },
        env: { HOME: sb.home }, platform: "linux", cwd: sb.project, isTTY: false, prompt: null,
        now: () => Date.UTC(2026, 10, 24), execPath: path.join(sb.base, "node", "bin", "node"), ...io
    });
    return { code, stdout };
}
const doctor = async (sb, argv, io) => JSON.parse((await run(sb, "doctor", [...argv, "--json"], io)).stdout);
const byId = (report, id) => report.checks.filter((c) => c.id === id);

function writeCursor(file, folder, extra = []) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp@stable-0.5", folder, ...extra] } } }));
}

test("Cursor: sentinel-ir in both the global and the project config is a warning in doctor and setup", async () => {
    const sb = sandbox();
    try {
        assert.equal((await run(sb, "setup", ["--client", "cursor", "--exclude", "secrets", "--yes"])).code, 0);
        assert.equal(byId(await doctor(sb, ["--client", "cursor"]), "cursor.duplicate").length, 0, "project only: no warning");
        writeCursor(path.join(sb.home, ".cursor", "mcp.json"), sb.project);
        const report = await doctor(sb, ["--client", "cursor"]);
        const dup = byId(report, "cursor.duplicate");
        assert.equal(dup.length, 1);
        assert.equal(dup[0].status, "warn");
        assert.match(dup[0].message, /exclusions and audit log/);
        assert.equal(byId(await doctor(sb, []), "cursor.duplicate").length, 1, "also without --client");
        const again = await run(sb, "setup", ["--client", "cursor", "--dry-run"]);
        assert.match(again.stdout, /\.cursor[\\/]mcp\.json also has a "sentinel-ir" server/);
        const global = await run(sb, "setup", ["--client", "cursor", "--global", "--dry-run"]);
        assert.match(global.stdout, /also has a "sentinel-ir" server/, "and the other way round");
    } finally { sb.cleanup(); }
});

test("Cursor: doctor --client cursor checks the global config when the project has none", async () => {
    const sb = sandbox();
    try {
        writeCursor(path.join(sb.home, ".cursor", "mcp.json"), sb.project);
        const report = await doctor(sb, ["--client", "cursor"]);
        assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status === "fail")));
        assert.match(byId(report, "cursor.location")[0].message, /checking the global/);
        assert.equal(byId(report, "cursor.entry")[0].status, "ok");
    } finally { sb.cleanup(); }
});

test("doctor warns about an npm min-release-age or before setting; none is quiet", async () => {
    const sb = sandbox();
    try {
        const warn = byId(await doctor(sb, [], { npmPolicy: () => ({ "min-release-age": "7", before: "null" }) }), "npm.policy");
        assert.equal(warn.length, 1);
        assert.match(warn[0].message, /min-release-age=7/);
        assert.match(warn[0].message, /deleting the npx cache does not change that/);
        assert.doesNotMatch(warn[0].message, /before=/);
        assert.equal(byId(await doctor(sb, [], { npmPolicy: () => ({ "min-release-age": "null", before: "null" }) }), "npm.policy").length, 0);
    } finally { sb.cleanup(); }
});

test("npmPolicy reads a project .npmrc through npm itself", () => {
    const sb = sandbox();
    try {
        fs.writeFileSync(path.join(sb.project, ".npmrc"), "min-release-age=7\n");
        const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
        if (npm.status !== 0) return;
        const values = npmPolicy(process.env, process.platform, process.execPath, sb.project);
        assert.ok(values, "npm answered");
        assert.equal(values["min-release-age"], "7");
    } finally { sb.cleanup(); }
});

test("cache advice works on npm 10 too: delete the folder, npm cache npx rm only as the npm 11 option", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "doctor.js"), "utf8");
    assert.doesNotMatch(src, /\(npm 11: npm cache npx rm/);
    assert.match(src, /delete that folder \(npm 11 can also: npm cache npx rm/);
});

test("several folders: a relative path is found in any of them; analyze_directory without path lists the others", async () => {
    const fx = makeFixture();
    const c = await connect({ roots: [fx.project, fx.outside] });
    try {
        const file = await call(c.client, "analyze_file", { path: "private.js" });
        assert.equal(file.isError, undefined, file.text);
        assert.equal((await call(c.client, "analyze_file", { path: "server.js" })).isError, undefined);
        const dir = JSON.parse((await call(c.client, "analyze_directory", {})).text);
        assert.deepEqual(dir.otherFolders, [fx.outside]);
        assert.match(dir.note, /Scanned only the first allowed folder/);
        const named = JSON.parse((await call(c.client, "analyze_directory", { path: fx.outside })).text);
        assert.equal(named.otherFolders, undefined);
        assert.match((await call(c.client, "analyze_file", { path: "../../etc/passwd.js" })).text, /outside the allowed folders/);
    } finally { await c.close(); fx.cleanup(); }
    const one = makeFixture();
    const d = await connect({ roots: [one.project] });
    try {
        assert.equal(JSON.parse((await call(d.client, "analyze_directory", {})).text).otherFolders, undefined);
    } finally { await d.close(); one.cleanup(); }
});

test("an exclusion still holds for a relative path found in the second folder", async () => {
    const fx = makeFixture();
    const c = await connect({ roots: [fx.project, fx.outside], exclude: ["private.js"] });
    try {
        assert.match((await call(c.client, "analyze_file", { path: "private.js" })).text, /Excluded/);
    } finally { await c.close(); fx.cleanup(); }
});

test("a symlink loop inside the folder is named; one pointing outside is still refused as outside", { skip: process.platform === "win32" }, async () => {
    const fx = makeFixture();
    fs.symlinkSync(path.join(fx.project, "loop-b.js"), path.join(fx.project, "loop-a.js"));
    fs.symlinkSync(path.join(fx.project, "loop-a.js"), path.join(fx.project, "loop-b.js"));
    const c = await connect({ roots: [fx.project] });
    try {
        assert.match((await call(c.client, "analyze_file", { path: "loop-a.js" })).text, /loop-a\.js is a symlink loop/);
        assert.match((await call(c.client, "analyze_file", { path: "link-to-outside.js" })).text, /outside the allowed folders/);
    } finally { await c.close(); fx.cleanup(); }
});

test("UTF-16 files with a byte order mark are read as text", async () => {
    const fx = makeFixture();
    const code = 'require("child_process").exec("ls");\n';
    fs.writeFileSync(path.join(fx.project, "le.js"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(code, "utf16le")]));
    fs.writeFileSync(path.join(fx.project, "be.js"), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(code, "utf16le").swap16()]));
    fs.writeFileSync(path.join(fx.project, "odd.js"), Buffer.from([0xfe, 0xff, 0x00]));
    const c = await connect({ roots: [fx.project] });
    try {
        for (const f of ["le.js", "be.js"]) {
            const ir = JSON.parse((await call(c.client, "analyze_file", { path: f })).text);
            assert.equal(ir.analysisStatus, "complete", f);
            assert.equal(ir.world.risk, "critical", f);
        }
        assert.equal((await call(c.client, "analyze_file", { path: "odd.js" })).isError, undefined, "odd length does not throw");
    } finally { await c.close(); fx.cleanup(); }
});

test("messages and help name the pinned npx command", async () => {
    const c = await connect({ roots: [] });
    try {
        assert.match((await call(c.client, "analyze_file", { path: "x.js" })).text, /npx -y sentinel-ir-mcp@stable-0\.5 \/path\/to\/project/);
    } finally { await c.close(); }
    const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(help, /^\s*sentinel-ir-mcp (setup|doctor|log)/m);
    assert.match(help, /See the log with: npx -y sentinel-ir-mcp@stable-0\.5 log/);
    for (const cmd of ["setup", "log"]) {
        const sb = sandbox();
        try {
            const out = (await run(sb, cmd, ["--help"])).stdout;
            assert.match(out, new RegExp(`Usage: npx -y sentinel-ir-mcp@stable-0\\.5 ${cmd}`));
            assert.doesNotMatch(out, /"sentinel-ir-mcp log"|: sentinel-ir-mcp setup/);
        } finally { sb.cleanup(); }
    }
});

test("SECURITY.md commands run in Windows PowerShell 5.1 (no &&)", () => {
    const sec = fs.readFileSync(path.join(__dirname, "..", "SECURITY.md"), "utf8");
    for (const block of sec.matchAll(/```sh\n([\s\S]*?)```/g)) assert.doesNotMatch(block[1], /&&/);
});

test("several folders: a relative path that leaves the folders never picks the folder, existing or not", async () => {
    const fx = makeFixture();
    const second = path.join(fx.base, "second");
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(second, "a.js"), "module.exports = 2;\n");
    // ../outside/private.js exists from project, ../outside/missing.js does not: same answer.
    const c = await connect({ roots: [fx.project, second] });
    try {
        const there = (await call(c.client, "analyze_file", { path: "../outside/private.js" })).text;
        const missing = (await call(c.client, "analyze_file", { path: "../outside/missing.js" })).text;
        assert.match(there, /outside the allowed folders/);
        assert.equal(there.replace("private", "X"), missing.replace("missing", "X"));
        // linked-dir/private.js resolves outside through a symlink in the first folder: skipped, so a.js-like
        // names in the second folder still win and outside existence does not change the answer.
        fs.writeFileSync(path.join(second, "private.js"), "module.exports = 3;\n");
        fs.mkdirSync(path.join(second, "linked-dir"));
        fs.writeFileSync(path.join(second, "linked-dir", "private.js"), "module.exports = 4;\n");
        const viaSecond = await call(c.client, "analyze_file", { path: "linked-dir/private.js" });
        assert.equal(viaSecond.isError, undefined, viaSecond.text);
    } finally { await c.close(); fx.cleanup(); }
});

test("a symlink loop outside the folders, reached through an allowed link, is refused as outside", { skip: process.platform === "win32" }, async () => {
    const fx = makeFixture();
    fs.symlinkSync(path.join(fx.outside, "y.js"), path.join(fx.outside, "x.js"));
    fs.symlinkSync(path.join(fx.outside, "x.js"), path.join(fx.outside, "y.js"));
    fs.symlinkSync(path.join(fx.outside, "x.js"), path.join(fx.project, "to-cycle.js"));
    const c = await connect({ roots: [fx.project] });
    try {
        const text = (await call(c.client, "analyze_file", { path: "to-cycle.js" })).text;
        assert.match(text, /outside the allowed folders/);
        assert.doesNotMatch(text, /loop/);
    } finally { await c.close(); fx.cleanup(); }
});

test("Cursor global-only: repair hints name --global; a broken project config is not skipped", async () => {
    const sb = sandbox();
    try {
        writeCursor(path.join(sb.home, ".cursor", "mcp.json"), path.join(sb.base, "gone"));
        const report = await doctor(sb, ["--client", "cursor"]);
        const hints = report.checks.map((c) => `${c.message} ${c.fix || ""}`).filter((t) => /setup --client cursor/.test(t));
        assert.ok(hints.length > 0, JSON.stringify(report.checks));
        for (const t of hints) assert.match(t, /setup --client cursor --global/, t);
        fs.mkdirSync(path.join(sb.project, ".cursor"));
        fs.writeFileSync(path.join(sb.project, ".cursor", "mcp.json"), "{ not json");
        const broken = await doctor(sb, ["--client", "cursor"]);
        assert.equal(broken.ok, false);
        assert.equal(byId(broken, "cursor.location").length, 0);
        assert.ok(broken.checks.some((c) => c.status === "fail" && /not valid JSON/.test(c.message)), JSON.stringify(broken.checks));
    } finally { sb.cleanup(); }
});

test("Cursor: a project .cursor that links to ~/.cursor is one config, not a duplicate", { skip: process.platform === "win32" }, async () => {
    const sb = sandbox();
    try {
        writeCursor(path.join(sb.home, ".cursor", "mcp.json"), sb.project);
        fs.symlinkSync(path.join(sb.home, ".cursor"), path.join(sb.project, ".cursor"));
        assert.equal(byId(await doctor(sb, ["--client", "cursor"]), "cursor.duplicate").length, 0);
        assert.doesNotMatch((await run(sb, "setup", ["--client", "cursor", "--dry-run"])).stdout, /also has a "sentinel-ir" server/);
    } finally { sb.cleanup(); }
});
