"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { resolveInside, plainPath, isSourceFile, canonicalRoots } = require("../src/paths");
const { analyzeCode, analyzeFile } = require("../src/analyze");
const { describe } = require("../src/logView");
const { runCommand } = require("../src/cli");
const { makeFixture, BIN } = require("./helpers");

const LIMITS = { maxFileBytes: 1024 * 1024 };

test("outside the folders: the same refusal whether or not the path exists", () => {
    const fx = makeFixture();
    try {
        const roots = [fx.project];
        const denied = [
            path.join(fx.outside, "private.js"), path.join(fx.outside, "missing.js"), path.join(fx.base, "nope", "deeper", "x.js"),
            "../outside/private.js", "../outside/missing.js", "../../../../../../nope/x.js", "linked-dir/missing.js"
        ];
        for (const p of denied) assert.throws(() => resolveInside(p, roots), (e) => e.message === `Access denied: ${p} is outside the allowed folders`, p);
        fs.symlinkSync(path.join(fx.outside, "gone.js"), path.join(fx.project, "dangling.js"));
        assert.throws(() => resolveInside("dangling.js", roots), /Access denied/);
        assert.throws(() => resolveInside("missing.js", roots), /Not found: missing\.js/);
        assert.throws(() => resolveInside("lib/new/missing.js", roots), /Not found/);
    } finally { fx.cleanup(); }
});

test("Windows \\\\?\\ paths and file:// URIs become plain paths", () => {
    assert.equal(plainPath("\\\\?\\C:\\p\\a.js", "win32"), "C:\\p\\a.js");
    assert.equal(plainPath("\\\\?\\UNC\\srv\\share\\a.js", "win32"), "\\\\srv\\share\\a.js");
    assert.equal(plainPath("\\\\?\\C:\\p\\a.js", "linux"), "\\\\?\\C:\\p\\a.js");
    assert.equal(plainPath("file:///tmp/a%20b/%C4%8D.js", "linux"), "/tmp/a b/č.js");
    assert.throws(() => plainPath("file://host/x.js", "linux"), /Not a file path: file:\/\/host\/x\.js is a URL/);
    assert.equal(plainPath("src/a.js", "win32"), "src/a.js");
});

test("a \\\\?\\ root on Windows takes plain and namespaced paths inside it", { skip: process.platform !== "win32" }, () => {
    const fx = makeFixture();
    try {
        const roots = canonicalRoots(["\\\\?\\" + fx.project]);
        assert.deepEqual(roots, [fs.realpathSync(fx.project)]);
        const file = fs.readdirSync(fx.project).find((n) => n.endsWith(".js") && !n.startsWith("link"));
        assert.ok(resolveInside("\\\\?\\" + path.join(fx.project, file), roots).real);
        assert.ok(resolveInside(file, roots).real);
    } finally { fx.cleanup(); }
});

test("analyze_file takes a file:// URI inside the folder", async () => {
    const fx = makeFixture();
    try {
        const file = fs.readdirSync(fx.project).find((n) => n.endsWith(".js") && !n.startsWith("link"));
        const ir = await analyzeFile(pathToFileURL(path.join(fx.project, file)).href, [fx.project], LIMITS);
        assert.equal(ir.mission.target, file);
        await assert.rejects(analyzeFile(pathToFileURL(path.join(fx.outside, "missing.js")).href, [fx.project], LIMITS), /Access denied/);
    } finally { fx.cleanup(); }
});

test(".jsx is read like sentinel-ir reads it", async () => {
    const fx = makeFixture();
    try {
        assert.ok(isSourceFile("App.JSX"));
        fs.writeFileSync(path.join(fx.project, "App.jsx"), 'export default () => <div onClick={() => eval(x)} />;\n');
        const ir = await analyzeFile("App.jsx", [fx.project], LIMITS);
        assert.equal(ir.language, "javascript");
        assert.equal(ir.analysisStatus, "complete");
        assert.equal(ir.world.risk, "critical");
        fs.writeFileSync(path.join(fx.project, "notes.txt"), "x");
        await assert.rejects(analyzeFile("notes.txt", [fx.project], LIMITS), /Unsupported file type: notes\.txt \(only .*\.jsx/);
    } finally { fx.cleanup(); }
});

test("analyze_code with an unsupported target extension is incomplete, not JavaScript", async () => {
    const ir = await analyzeCode('system("ls")', "x.rb");
    assert.equal(ir.analysisStatus, "incomplete");
    assert.equal(ir.language, "unknown");
    assert.match(ir.facts.reason, /unsupported file type: \.rb/);
});

test("the log names hard-link, symlink and unsupported refusals in short words", () => {
    const line = (reason) => describe({ tool: "analyze_file", path: "h.js", ok: false, reason, message: "Access denied: h.js has 2 hard links; files with more than one are refused" })[0];
    assert.equal(line("hardlink"), "REFUSED file h.js: file has several hard links");
    assert.equal(line("symlink"), "REFUSED file h.js: symlink");
    assert.equal(line("unsupported"), "REFUSED file h.js: unsupported file type");
});

test("log | head: a closed pipe ends the command quietly", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-epipe-")));
    try {
        const entry = JSON.stringify({ ts: "2026-11-15T10:00:00.000Z", tool: "analyze_file", path: "x".repeat(200) + ".js", ok: true, risk: "low" });
        const today = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(path.join(dir, `audit-${today}.jsonl`), (entry + "\n").repeat(5000), { mode: 0o600 });
        for (const extra of [["--all"], ["--all", "--json"]]) {
            const child = spawn(process.execPath, [BIN, "log", "--dir", dir, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (d) => { stderr += d; });
            child.stdout.once("data", () => child.stdout.destroy());
            const code = await new Promise((resolve) => child.on("close", resolve));
            assert.equal(stderr, "", extra.join(" "));
            assert.equal(code, 0, extra.join(" "));
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("doctor without --client shows the exclusions and audit log of each configured client", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-doctor-")));
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    const logs = path.join(base, "logs");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "a.js"), "module.exports = 1;\n");
    const run = async (command, argv) => {
        let stdout = "";
        const io = {
            stdout: { write: (s) => { stdout += s; } }, stderr: { write: () => {} },
            env: { HOME: home }, platform: "linux", cwd: project, isTTY: false, prompt: null,
            now: () => Date.UTC(2026, 10, 15), execPath: path.join(base, "node", "bin", "node")
        };
        return { code: await runCommand(command, argv, io), stdout };
    };
    try {
        assert.equal((await run("setup", ["--client", "cursor", "--yes", "--exclude", "secrets"])).code, 0);
        assert.equal((await run("setup", ["--client", "windsurf", "--yes", `--audit-log=${logs}`])).code, 0);
        const { stdout } = await run("doctor", ["--json"]);
        const checks = JSON.parse(stdout).checks;
        const lines = checks.filter((c) => c.id === "exclude" || c.id === "audit").map((c) => c.message);
        assert.ok(lines.some((m) => /^Cursor: .*secrets/.test(m)), lines.join("\n"));
        assert.ok(lines.some((m) => /^Cursor: Audit log: off/.test(m)), lines.join("\n"));
        assert.ok(lines.some((m) => /^Windsurf: Audit log: on/.test(m)), lines.join("\n"));
        assert.ok(!lines.some((m) => /^Windsurf: .*secrets/.test(m)), lines.join("\n"));
        assert.match(checks.find((c) => c.id === "mcp.settings").message, /uses the Cursor settings/);
        const single = JSON.parse((await run("doctor", ["--json", "--client", "windsurf"])).stdout).checks;
        assert.ok(single.some((c) => c.id === "audit" && /^Audit log: on/.test(c.message)));
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
