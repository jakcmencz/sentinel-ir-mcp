"use strict";

// Fixes from the 0.5.22 test with real agents on Linux, macOS and Windows.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createServer } = require("../src/server");
const { runCommand, parse } = require("../src/cli");
const { describeExcluded } = require("../src/excludeReport");
const { call } = require("./helpers");

async function connect(options) {
    const server = createServer(options);
    const client = new Client({ name: "v0523", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, close: async () => { await client.close(); await server.close(); } };
}

function sandbox() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-v0523-")));
    const home = path.join(base, "home");
    const first = path.join(base, "first");
    const second = path.join(base, "second");
    for (const d of [home, first, second]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(first, "common.js"), `require("child_process").execSync(process.env.CMD);\n`);
    fs.writeFileSync(path.join(second, "common.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(second, "only.js"), "module.exports = 2;\n");
    return { base, home, first, second, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function run(sb, command, argv, io = {}) {
    let stdout = "";
    const code = await runCommand(command, argv, {
        stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stdout += s; } },
        env: { HOME: sb.home }, platform: "linux", cwd: sb.first, isTTY: false, prompt: null,
        now: () => Date.UTC(2026, 10, 24), execPath: path.join(sb.base, "node", "bin", "node"), ...io
    });
    return { code, stdout };
}
const doctor = async (sb, argv, io) => JSON.parse((await run(sb, "doctor", [...argv, "--json"], io)).stdout);
const byId = (report, id) => report.checks.filter((c) => c.id === id);

test("several folders: scan paths are full paths and analyze_file reads exactly that file", async () => {
    const sb = sandbox();
    const c = await connect({ roots: [sb.first, sb.second] });
    try {
        const dir = (await call(c.client, "analyze_directory", { path: sb.second })).structuredContent;
        assert.deepEqual(dir.allowedFolders, [sb.first, sb.second]);
        assert.equal(dir.folder, sb.second);
        const entry = dir.files.find((f) => f.path === path.join(sb.second, "common.js"));
        assert.ok(entry, JSON.stringify(dir.files));
        assert.equal(entry.risk, "low");
        const again = await call(c.client, "analyze_file", { path: entry.path });
        assert.equal(again.isError, undefined, again.text);
        assert.equal(again.structuredContent.sha256, entry.sha256);
        assert.equal(again.structuredContent.world.risk, "low");
        const ambiguous = await call(c.client, "analyze_file", { path: "common.js" });
        assert.equal(ambiguous.isError, true);
        assert.match(ambiguous.text, /Ambiguous path: common\.js exists in 2 allowed folders/);
        assert.ok(ambiguous.text.includes(path.join(sb.first, "common.js")), ambiguous.text);
        assert.equal((await call(c.client, "analyze_file", { path: "only.js" })).isError, undefined);
        const first = (await call(c.client, "analyze_directory", {})).structuredContent;
        assert.equal(first.folder, sb.first);
        assert.ok(first.files.every((f) => path.isAbsolute(f.path)), JSON.stringify(first.files));
        assert.match(c.client.getInstructions(), /Allowed folders: .*first.*second.*full path/);
    } finally { await c.close(); sb.cleanup(); }
});

test("several folders: a relative path excluded in all of them is refused as excluded, not ambiguous", async () => {
    const sb = sandbox();
    const c = await connect({ roots: [sb.first, sb.second], exclude: ["common.js"] });
    try {
        const r = await call(c.client, "analyze_file", { path: "common.js" });
        assert.equal(r.isError, true);
        assert.match(r.text, /Excluded by the user's settings/);
    } finally { await c.close(); sb.cleanup(); }
});

test("one folder: paths stay relative and there is no allowedFolders", async () => {
    const sb = sandbox();
    const c = await connect({ roots: [sb.second] });
    try {
        const dir = (await call(c.client, "analyze_directory", {})).structuredContent;
        assert.equal(dir.allowedFolders, undefined);
        assert.deepEqual(dir.files.map((f) => f.path).sort(), ["common.js", "only.js"]);
    } finally { await c.close(); sb.cleanup(); }
});

test("analyze_code refuses empty or whitespace-only code", async () => {
    const sb = sandbox();
    const c = await connect({ roots: [sb.first] });
    try {
        for (const code of ["", "  \n\t "]) {
            const r = await call(c.client, "analyze_code", { code });
            assert.equal(r.isError, true, JSON.stringify(code));
            assert.match(r.text, /code is empty/);
        }
        assert.equal((await call(c.client, "analyze_code", { code: "x = 1" })).isError, undefined);
    } finally { await c.close(); sb.cleanup(); }
});

test("setup refuses --project given twice and explains a second bare folder", async () => {
    assert.throws(() => parse("setup", ["--project", "a", "--project", "b"]), /--project given more than once; setup gives the agent one folder/);
    assert.throws(() => parse("setup", ["--client", "cursor", "--client", "vscode"]), /--client given more than once/);
    assert.throws(() => parse("setup", ["a", "b"]), /pass it with --project/);
    assert.throws(() => parse("log", ["--audit-log"]), /log reads the audit log from --dir/);
    const sb = sandbox();
    try {
        const r = await run(sb, "setup", ["--client", "cursor", "--project", sb.first, "--project", sb.second, "--yes"]);
        assert.notEqual(r.code, 0);
        assert.equal(fs.existsSync(path.join(sb.second, ".cursor")), false);
        assert.equal(fs.existsSync(path.join(sb.first, ".cursor")), false);
    } finally { sb.cleanup(); }
});

test("an exclusion meant for one of several folders is not called a typo", () => {
    const sb = sandbox();
    try {
        fs.mkdirSync(path.join(sb.first, "secrets"));
        fs.writeFileSync(path.join(sb.first, "secrets", "k.js"), "x\n");
        const lines = describeExcluded(["secrets", "nothing-here"], [sb.first, sb.second], new Set());
        const typo = lines.filter((l) => l.includes("matches nothing"));
        assert.deepEqual(typo, ["  matches nothing in any of these folders yet (typo?): nothing-here"]);
        assert.deepEqual(describeExcluded(["secrets"], [sb.first, sb.second], new Set()).filter((l) => l.includes("matches nothing")), []);
        assert.match(describeExcluded(["nope"], [sb.second], new Set()).join("\n"), /matches nothing there yet \(typo\?\): nope/);
    } finally { sb.cleanup(); }
});

test("npm policy: npm 10 ignores min-release-age; before shows the date and ENOVERSIONS", async () => {
    const sb = sandbox();
    try {
        assert.equal(byId(await doctor(sb, [], { npmPolicy: () => ({ "min-release-age": "7", before: "null", npmVersion: "10.9.2" }) }), "npm.policy").length, 0);
        assert.equal(byId(await doctor(sb, [], { npmPolicy: () => ({ "min-release-age": "7", before: "null", npmVersion: "11.6.2" }) }), "npm.policy").length, 1);
        const before = byId(await doctor(sb, [], { npmPolicy: () => ({ "min-release-age": "null", before: new Date(Date.UTC(2025, 0, 2)).toString(), npmVersion: "10.9.2" }) }), "npm.policy");
        assert.equal(before.length, 1);
        assert.match(before[0].message, /before=2025-01-02[ ,(]/);
        assert.match(before[0].message, /ENOVERSIONS/);
    } finally { sb.cleanup(); }
});

test("Windows hints quote folders with double quotes (PowerShell and cmd.exe)", async () => {
    const sb = sandbox();
    const project = path.join(sb.base, "my project");
    fs.mkdirSync(project);
    try {
        const r = await run(sb, "setup", ["--client", "cursor", "--project", project, "--yes"], { platform: "win32", env: { USERPROFILE: sb.home, APPDATA: path.join(sb.home, "AppData") } });
        assert.equal(r.code, 0, r.stdout);
        assert.ok(r.stdout.includes(`--project "${project}"`), r.stdout);
        assert.ok(!r.stdout.includes(`--project '${project}'`), r.stdout);
    } finally { sb.cleanup(); }
});

test("a symlink loop in a parent folder is named as a loop", { skip: process.platform === "win32" }, async () => {
    const sb = sandbox();
    fs.symlinkSync(path.join(sb.first, "dB"), path.join(sb.first, "dA"));
    fs.symlinkSync(path.join(sb.first, "dA"), path.join(sb.first, "dB"));
    const c = await connect({ roots: [sb.first] });
    try {
        assert.match((await call(c.client, "analyze_file", { path: "dA/x.js" })).text, /dA\/x\.js is a symlink loop/);
    } finally { await c.close(); sb.cleanup(); }
});

test("hard links skipped in a scan do not take places in max_files", { skip: process.platform === "win32" }, async () => {
    const sb = sandbox();
    for (const n of ["h1.js", "h2.js"]) fs.linkSync(path.join(sb.second, "only.js"), path.join(sb.second, n));
    fs.writeFileSync(path.join(sb.second, "z.js"), "module.exports = 3;\n");
    const c = await connect({ roots: [sb.second] });
    try {
        const dir = (await call(c.client, "analyze_directory", { max_files: 2 })).structuredContent;
        assert.deepEqual(dir.files.map((f) => f.path).sort(), ["common.js", "z.js"]);
        assert.deepEqual(dir.skipped.hardlinks.sort(), ["h1.js", "h2.js", "only.js"]);
        assert.equal(dir.truncated, false);
    } finally { await c.close(); sb.cleanup(); }
});
