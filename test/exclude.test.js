"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { normalizePattern, createExcluder, isExcluded } = require("../src/exclude");
const { analyzeFile, analyzeDirectory, readInside } = require("../src/analyze");
const { installCommand, serverEntry, entryExcludes } = require("../src/clients");
const { entryFolders } = require("../src/doctor");
const { runCommand } = require("../src/cli");
const { BIN, connectStdio, call } = require("./helpers");

const MARKER = "EXCLUDED_SECRET_MARKER";
const LIMITS = { maxFiles: 50, maxFileBytes: 1024 * 1024 };

// project/
//   app.js, lib/util.js, lib/deep/keep.js
//   secrets/aws.js, lib/secrets/token.js       (name "secrets" anywhere)
//   config/prod.js, src/config/prod.js         ("config/prod.js" only at the top)
//   dist/bundle.min.js, vendor.min.js          ("*.min.js")
function fixture() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-exclude-")));
    const project = path.join(base, "project");
    const files = {
        "app.js": "module.exports = 1;\n",
        "lib/util.js": "exports.a = 1;\n",
        "lib/deep/keep.js": "exports.b = 2;\n",
        "secrets/aws.js": `module.exports = "${MARKER}"; eval("x");\n`,
        "lib/secrets/token.js": `module.exports = "${MARKER}";\n`,
        "config/prod.js": `module.exports = "${MARKER}";\n`,
        "src/config/prod.js": "module.exports = 3;\n",
        "dist/bundle.min.js": `var a="${MARKER}";\n`,
        "vendor.min.js": `var b="${MARKER}";\n`
    };
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
        fs.writeFileSync(path.join(project, rel), text);
    }
    return { base, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const PATTERNS = ["secrets", "config/prod.js", "*.min.js"];
const excl = (patterns = PATTERNS, caseInsensitive = false) => ({ ...LIMITS, excluder: createExcluder(patterns, { caseInsensitive }) });

function canSymlink(dir) {
    try {
        fs.symlinkSync(path.join(dir, "app.js"), path.join(dir, "probe"));
        fs.unlinkSync(path.join(dir, "probe"));
        return true;
    } catch {
        return false;
    }
}

test("patterns: accepted spellings are normalized, unsafe ones refused with a clear message", () => {
    assert.equal(normalizePattern(" ./dist/ "), "dist");
    assert.equal(normalizePattern("src\\generated\\"), "src/generated");
    assert.equal(normalizePattern("a//b"), "a/b");
    assert.equal(normalizePattern("**/*.min.js"), "**/*.min.js");
    for (const bad of ["", "   ", ".", "./", "..", "../x", "a/../b", "a/./b", "/etc", "C:\\x", "c:x", "!keep.js",
        "a&b", "a|b", "a%OS%", "a\"b", "a^b", "a<b", "a>b", "a\nb", "a\u0000b", "x".repeat(257)]) {
        assert.throws(() => normalizePattern(bad), Error, JSON.stringify(bad));
    }
    assert.throws(() => normalizePattern(5), /text/);
    assert.throws(() => createExcluder(Array.from({ length: 101 }, (_, i) => `f${i}`)), /at most 100/);
    assert.deepEqual(createExcluder(["dist", "./dist", "dist/"]).patterns, ["dist"]);
});

test("patterns: name anywhere, path from the folder, masks, ** and folder contents", () => {
    const e = createExcluder(["secrets", "config/prod.js", "*.min.js", "gen/**/out", "**/tmp"], { caseInsensitive: false });
    const yes = ["secrets", "secrets/a.js", "a/b/secrets/c.js", "config/prod.js", "a.min.js", "x/y/a.min.js",
        "gen/out", "gen/a/b/out/x.js", "tmp", "a/tmp/b.js"];
    const no = ["secretsx/a.js", "my-secrets/a.js", "src/config/prod.js", "config/prod.jsx", "a.min.jsx", "gen/x/outx",
        "app.js", "", ".", "SECRETS/a.js"];
    for (const r of yes) assert.equal(e.matches(r), true, r);
    for (const r of no) assert.equal(e.matches(r), false, r);
    const ci = createExcluder(["secrets"], { caseInsensitive: true });
    assert.equal(ci.matches("SeCrEtS/a.js"), true);
    assert.equal(ci.matches("a\\SECRETS\\b.js"), true);
    // macOS hands out decomposed names; "složka" must match both forms.
    const nfc = createExcluder(["slo\u017eka"], { caseInsensitive: false });
    assert.equal(nfc.matches("slo\u007a\u030cka/a.js"), true);
    // Regex characters in names are literal.
    const lit = createExcluder(["a+b(1).js", "x[1].js"], { caseInsensitive: false });
    assert.equal(lit.matches("a+b(1).js"), true);
    assert.equal(lit.matches("aab(1).js"), false);
    assert.equal(lit.matches("x[1].js"), true);
    assert.equal(lit.matches("x1.js"), false);
});

test("analyze_file refuses excluded files under every spelling, and does not reveal whether they exist", async () => {
    const fx = fixture();
    try {
        const roots = [fx.project];
        for (const p of ["secrets/aws.js", "./secrets/aws.js", "lib/../secrets/aws.js", "secrets//aws.js", "secrets/./aws.js",
            "lib/secrets/token.js", "config/prod.js", "vendor.min.js", "dist/bundle.min.js",
            path.join(fx.project, "secrets", "aws.js"), "secrets/does-not-exist.js", "lib/secrets/nope.py"]) {
            await assert.rejects(analyzeFile(p, roots, excl()), /Excluded by the user's settings/, p);
        }
        await assert.rejects(analyzeFile("missing.js", roots, excl()), /Not found/);
        assert.equal((await analyzeFile("src/config/prod.js", roots, excl())).analysisStatus, "complete");
        assert.equal((await analyzeFile("app.js", roots, excl())).analysisStatus, "complete");
        // The folder check stays first: outside paths are still "outside", not "excluded".
        await assert.rejects(analyzeFile("../outside.js", roots, excl()), /Not found|outside/);
    } finally {
        fx.cleanup();
    }
});

test("letter case: refused on case-insensitive systems, a different file on Linux", async () => {
    const fx = fixture();
    try {
        await assert.rejects(analyzeFile("SECRETS/aws.js", [fx.project], excl(PATTERNS, true)), /Excluded/);
        await assert.rejects(analyzeFile("Config/PROD.js", [fx.project], excl(PATTERNS, true)), /Excluded/);
        if (process.platform === "linux") {
            fs.mkdirSync(path.join(fx.project, "SECRETS"));
            fs.writeFileSync(path.join(fx.project, "SECRETS", "ok.js"), "exports.c = 1;\n");
            assert.equal((await analyzeFile("SECRETS/ok.js", [fx.project], excl())).analysisStatus, "complete");
        }
    } finally {
        fx.cleanup();
    }
});

test("symlinks and hard links to excluded files are refused", async (t) => {
    const fx = fixture();
    try {
        if (!canSymlink(fx.project)) return t.skip("no symlinks here");
        fs.symlinkSync(path.join(fx.project, "secrets", "aws.js"), path.join(fx.project, "innocent.js"));
        fs.symlinkSync(path.join(fx.project, "secrets"), path.join(fx.project, "docs"));
        fs.symlinkSync(path.join(fx.project, "config"), path.join(fx.project, "cfg"));
        for (const p of ["innocent.js", "docs/aws.js", "cfg/prod.js"]) {
            await assert.rejects(analyzeFile(p, [fx.project], excl()), /Excluded/, p);
        }
        fs.linkSync(path.join(fx.project, "config", "prod.js"), path.join(fx.project, "copy.js"));
        await assert.rejects(analyzeFile("copy.js", [fx.project], excl()), /hard links/);
        const r = await analyzeDirectory(".", [fx.project], excl());
        assert.ok(!JSON.stringify(r).includes(MARKER));
        assert.ok(r.skipped.hardlinks.includes("copy.js"));
    } finally {
        fx.cleanup();
    }
});

test("the read-time check refuses an excluded path too (a folder renamed between listing and reading)", async () => {
    const fx = fixture();
    try {
        const e = createExcluder(PATTERNS, { caseInsensitive: false });
        await assert.rejects(readInside(path.join(fx.project, "secrets", "aws.js"), [fx.project], 1024, "x", e), /Excluded/);
        assert.match(await readInside(path.join(fx.project, "app.js"), [fx.project], 1024, "x", e), /exports/);
        assert.equal(isExcluded(path.join(fx.project, "lib", "secrets", "token.js"), [fx.project], e), true);
        assert.equal(isExcluded(path.join(fx.base, "secrets"), [fx.project], e), false);
    } finally {
        fx.cleanup();
    }
});

test("analyze_directory leaves excluded files out, counts them, and never names them", async () => {
    const fx = fixture();
    try {
        const r = await analyzeDirectory(".", [fx.project], excl());
        assert.deepEqual(r.files.map((f) => f.path).sort(), ["app.js", "lib/deep/keep.js", "lib/util.js", "src/config/prod.js"]);
        // secrets/, lib/secrets/, config/prod.js, dist/bundle.min.js, vendor.min.js
        assert.equal(r.skipped.excluded, 5);
        assert.equal(r.analyzed, 4);
        const text = JSON.stringify(r);
        for (const leak of [MARKER, "aws", "token", "bundle", "vendor"]) assert.ok(!text.includes(leak), leak);
        assert.equal(r.riskCounts.critical, 0);
        // A sub-folder: patterns stay relative to the allowed folder.
        const lib = await analyzeDirectory("lib", [fx.project], excl());
        assert.deepEqual(lib.files.map((f) => f.path).sort(), ["lib/deep/keep.js", "lib/util.js"]);
        assert.equal(lib.skipped.excluded, 1);
        const src = await analyzeDirectory("src", [fx.project], excl());
        assert.deepEqual(src.files.map((f) => f.path), ["src/config/prod.js"]);
        const config = await analyzeDirectory("config", [fx.project], excl());
        assert.equal(config.analyzed, 0);
        assert.equal(config.skipped.excluded, 1);
        assert.ok(!JSON.stringify(config).includes(MARKER));
        for (const p of ["secrets", "lib/secrets", "./secrets/", "lib/../secrets"]) {
            await assert.rejects(analyzeDirectory(p, [fx.project], excl()), /Excluded/, p);
        }
        // Without exclusions nothing changes.
        const all = await analyzeDirectory(".", [fx.project], LIMITS);
        assert.equal(all.skipped.excluded, 0);
        assert.equal(all.analyzed, 9);
    } finally {
        fx.cleanup();
    }
});

test("excluded files do not use up max_files and are not reported as too large", async () => {
    const fx = fixture();
    try {
        fs.writeFileSync(path.join(fx.project, "secrets", "big.js"), "x".repeat(4096));
        const r = await analyzeDirectory(".", [fx.project], { ...excl(["app.js", "secrets"]), maxFiles: 1, maxFileBytes: 1024 });
        assert.equal(r.analyzed, 1);
        assert.notEqual(r.files[0].path, "app.js");
        assert.deepEqual(r.skipped.tooLarge, []);
        await assert.rejects(analyzeFile("secrets/big.js", [fx.project], { ...excl(), maxFileBytes: 1024 }), /Excluded/);
    } finally {
        fx.cleanup();
    }
});

test("with several allowed folders the patterns apply inside each of them", async () => {
    const fx = fixture();
    const other = path.join(fx.base, "other");
    try {
        fs.mkdirSync(path.join(other, "secrets"), { recursive: true });
        fs.writeFileSync(path.join(other, "secrets", "k.js"), `module.exports = "${MARKER}";\n`);
        fs.writeFileSync(path.join(other, "ok.js"), "exports.x = 1;\n");
        const roots = [fx.project, other];
        await assert.rejects(analyzeFile(path.join(other, "secrets", "k.js"), roots, excl()), /Excluded/);
        const r = await analyzeDirectory(other, roots, excl());
        assert.deepEqual(r.files.map((f) => f.path), ["ok.js"]);
        assert.equal(r.skipped.excluded, 1);
    } finally {
        fx.cleanup();
    }
});

test("server: --exclude is enforced over MCP, analyze_code is unaffected, the note appears only when set", async () => {
    const fx = fixture();
    let client;
    let plain;
    try {
        client = await connectStdio(["--exclude", "secrets", "--exclude=*.min.js", fx.project]);
        const r = await call(client, "analyze_file", { path: "secrets/aws.js" });
        assert.equal(r.isError, true);
        assert.match(r.text, /Excluded by the user's settings/);
        const d = await call(client, "analyze_directory", {});
        assert.equal(d.structuredContent.skipped.excluded, 4);
        assert.ok(!d.text.includes(MARKER));
        const c = await call(client, "analyze_code", { code: "eval(x)" });
        assert.equal(c.structuredContent.world.risk, "critical");
        const tools = (await client.listTools()).tools;
        assert.equal(tools.length, 3);
        for (const name of ["analyze_file", "analyze_directory"]) {
            const desc = tools.find((x) => x.name === name).description;
            assert.match(desc, /skipped\.excluded/);
            assert.ok(!desc.includes("secrets"), "patterns are not shown to the agent");
        }
        assert.match(client.getInstructions(), /excluded/);
        plain = await connectStdio([fx.project]);
        const desc = (await plain.listTools()).tools.find((x) => x.name === "analyze_file").description;
        assert.ok(!/excluded/i.test(desc));
    } finally {
        await client?.close();
        await plain?.close();
        fx.cleanup();
    }
});

test("server CLI refuses bad --exclude values before starting", () => {
    for (const args of [["--exclude"], ["--exclude", "../x"], ["--exclude=/etc"], ["--exclude", "a&b"], ["--exclude="]]) {
        const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", input: "" });
        assert.equal(r.status, 2, args.join(" ") + r.stderr);
        assert.match(r.stderr, /exclu/);
    }
    const many = Array.from({ length: 101 }, (_, i) => `--exclude=f${i}`);
    assert.equal(spawnSync(process.execPath, [BIN, ...many], { encoding: "utf8", input: "" }).status, 2);
    assert.match(spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }).stdout, /--exclude <name>/);
});

test("client entries and install commands carry the exclusions on every platform", () => {
    const ex = ["secrets", "*.min.js", "my docs"];
    assert.deepEqual(serverEntry("/p", "linux", ex).args, ["-y", "sentinel-ir-mcp@0.5", "--exclude=secrets", "--exclude=*.min.js", "--exclude=my docs", "/p"]);
    assert.deepEqual(serverEntry("C:\\p", "win32", ex).args.slice(0, 4), ["/c", "npx", "-y", "sentinel-ir-mcp@0.5"]);
    assert.deepEqual(serverEntry("/p", "linux").args, ["-y", "sentinel-ir-mcp@0.5", "/p"]);
    assert.deepEqual(entryExcludes(["-y", "x", "--exclude", "a", "--exclude=b", "/p"]), ["a", "b"]);
    assert.deepEqual(entryFolders(["-y", "sentinel-ir-mcp@0.5", "--exclude", "a", "--exclude=b", "/p"]), ["/p"]);
    assert.equal(installCommand("claude-code", "/p", "linux", undefined, ex),
        "claude mcp add --transport stdio sentinel-ir -- npx -y sentinel-ir-mcp@0.5 --exclude=secrets '--exclude=*.min.js' '--exclude=my docs' /p");
    assert.equal(installCommand("claude-code", "C:\\p", "win32", "powershell", ["secrets"]),
        "claude mcp add --transport stdio sentinel-ir '--' cmd /c npx -y sentinel-ir-mcp@0.5 '--exclude=secrets' 'C:\\p'");
    assert.equal(installCommand("claude-code", "C:\\p", "win32", "cmd", ["*.min.js"]),
        "claude mcp add --transport stdio sentinel-ir -- cmd /c npx -y sentinel-ir-mcp@0.5 \"--exclude=*.min.js\" \"C:\\p\"");
    assert.match(installCommand("claude-code", "C:\\50%", "win32", "cmd", ["secrets"]), /add-json .*--exclude=secrets/);
    assert.match(installCommand("vscode", "/p", "linux", undefined, ["secrets"]), /"--exclude=secrets","\/p"/);
    assert.match(installCommand("vscode", "C:\\p", "win32", "cmd", ["secrets"]), /--exclude=secrets/);
});

function sandbox() {
    const fx = fixture();
    const home = path.join(fx.base, "home");
    fs.mkdirSync(home);
    return { ...fx, home, file: path.join(home, ".config", "devin", "mcp_config.json") };
}

async function cli(sb, command, argv, { answers, platform = "linux" } = {}) {
    let stdout = "";
    let stderr = "";
    const questions = [];
    const queue = answers ? [...answers] : null;
    const io = {
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
        env: { HOME: sb.home }, platform, cwd: sb.project,
        isTTY: Boolean(queue), prompt: queue ? async (q) => { questions.push(q); return queue.shift() ?? ""; } : null,
        now: () => Date.UTC(2026, 9, 18)
    };
    const code = await runCommand(command, argv, io);
    return { code, stdout, stderr, questions };
}
const argsOf = (sb) => JSON.parse(fs.readFileSync(sb.file, "utf8")).mcpServers["sentinel-ir"].args;

test("setup --exclude writes the list; a new setup keeps it; --no-exclude removes it", async () => {
    const sb = sandbox();
    try {
        const r = await cli(sb, "setup", ["--client", "windsurf", "--exclude", "secrets", "--exclude", "*.min.js", "--yes"]);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /Excluded: secrets, \*\.min\.js/);
        assert.match(r.stdout, /4 file\(s\) or folder\(s\) excluded right now/);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.5", "--exclude=secrets", "--exclude=*.min.js", sb.project]);
        const again = await cli(sb, "setup", ["--client", "windsurf", "--yes"]);
        assert.match(again.stdout, /Already set up/);
        assert.deepEqual(argsOf(sb).slice(2, 4), ["--exclude=secrets", "--exclude=*.min.js"]);
        assert.equal((await cli(sb, "setup", ["--client", "windsurf", "--no-exclude", "--yes"])).code, 0);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.5", sb.project]);
        const both = await cli(sb, "setup", ["--client", "windsurf", "--no-exclude", "--exclude", "x", "--yes"]);
        assert.equal(both.code, 1);
        assert.match(both.stderr, /either/);
    } finally {
        sb.cleanup();
    }
});

test("setup refuses a bad exclusion and writes nothing; it warns about a pattern that matches nothing", async () => {
    const sb = sandbox();
    try {
        const bad = await cli(sb, "setup", ["--client", "windsurf", "--exclude", "../outside", "--yes"]);
        assert.equal(bad.code, 1);
        assert.match(bad.stderr, /inside the project.*Nothing was changed/);
        assert.equal(fs.existsSync(sb.file), false);
        const typo = await cli(sb, "setup", ["--client", "windsurf", "--exclude", "secrest", "--exclude", "secrets", "--dry-run"]);
        assert.match(typo.stdout, /matches nothing there yet \(typo\?\): secrest\n/);
    } finally {
        sb.cleanup();
    }
});

test("interactive setup asks once: answer, Enter keeps, - removes", async () => {
    const sb = sandbox();
    try {
        const first = await cli(sb, "setup", ["--client", "windsurf"], { answers: [" secrets , dist ,, ", "", "y"] });
        assert.equal(first.code, 0, first.stderr);
        assert.match(first.questions[0], /Enter = none/);
        assert.deepEqual(argsOf(sb).slice(2, 4), ["--exclude=secrets", "--exclude=dist"]);
        const keep = await cli(sb, "setup", ["--client", "windsurf"], { answers: ["", ""] });
        assert.match(keep.questions[0], /now: secrets, dist; Enter = keep, - = none/);
        assert.match(keep.stdout, /Already set up/);
        const clear = await cli(sb, "setup", ["--client", "windsurf"], { answers: ["-", "", "y"] });
        assert.equal(clear.code, 0);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.5", sb.project]);
        const invalid = await cli(sb, "setup", ["--client", "windsurf"], { answers: ["a|b"] });
        assert.equal(invalid.code, 1);
        assert.match(invalid.stderr, /not allowed/);
        const cmd = await cli(sb, "setup", ["--client", "claude-code"], { answers: ["secrets", ""] });
        assert.match(cmd.stdout, /npx -y sentinel-ir-mcp@0\.5 --exclude=secrets /);
    } finally {
        sb.cleanup();
    }
});

test("doctor shows the exclusions, runs the server with them, and fails on a broken one", async () => {
    const sb = sandbox();
    try {
        await cli(sb, "setup", ["--client", "windsurf", "--exclude", "secrets", "--yes"]);
        const r = await cli(sb, "doctor", ["--client", "windsurf", "--json"]);
        const report = JSON.parse(r.stdout);
        assert.equal(r.code, 0, r.stdout);
        const lines = report.checks.filter((c) => c.id === "exclude").map((c) => c.message);
        assert.match(lines[0], /Excluded: secrets/);
        assert.match(lines[1], /2 file\(s\) or folder\(s\) excluded right now, e\.g\. secrets\/, lib\/secrets\//);
        assert.ok(report.checks.some((c) => c.id === "mcp.call" && c.status === "ok"));
        const data = JSON.parse(fs.readFileSync(sb.file, "utf8"));
        data.mcpServers["sentinel-ir"].args.splice(2, 0, "--exclude=../x");
        fs.writeFileSync(sb.file, JSON.stringify(data));
        const broken = await cli(sb, "doctor", ["--client", "windsurf", "--json"]);
        assert.equal(broken.code, 1);
        assert.ok(JSON.parse(broken.stdout).checks.some((c) => c.id === "windsurf.exclude" && c.status === "fail"));
    } finally {
        sb.cleanup();
    }
});

test("Windows: a short 8.3 name does not get past an exclusion", { skip: process.platform !== "win32" }, async (t) => {
    const fx = fixture();
    try {
        fs.mkdirSync(path.join(fx.project, "privatefolder"));
        fs.writeFileSync(path.join(fx.project, "privatefolder", "k.js"), `module.exports = "${MARKER}";\n`);
        const r = spawnSync("cmd", ["/c", "for %I in (privatefolder) do @echo %~sI"], { cwd: fx.project, encoding: "utf8" });
        const short = path.win32.basename(String(r.stdout).trim().replace(/"/g, ""));
        if (!short || short.toLowerCase() === "privatefolder") return t.skip("8.3 names are off on this volume");
        t.diagnostic(`short name: ${short}`);
        const e = excl(["privatefolder"], true);
        await assert.rejects(analyzeFile(`${short}/k.js`, [fx.project], e), /Excluded/);
        await assert.rejects(analyzeDirectory(short, [fx.project], e), /Excluded/);
        const anchored = excl(["privatefolder/k.js"], true);
        await assert.rejects(analyzeFile(`${short}\\k.js`, [fx.project], anchored), /Excluded/);
        const d = await analyzeDirectory(".", [fx.project], anchored);
        assert.ok(!JSON.stringify(d).includes(MARKER));
    } finally {
        fx.cleanup();
    }
});
