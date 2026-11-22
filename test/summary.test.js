"use strict";

// Consistency of the analyze_directory summary (statusCounts, incomplete,
// skipped.unreadable) when files fail to parse or cannot be read at all.
const { test, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const sentinelIr = require("sentinel-ir");

const realAnalyzeAsync = sentinelIr.analyzeAsync;
mock.method(sentinelIr, "analyzeAsync", (code, options) => {
    if (options && typeof options.target === "string" && options.target.includes("explode")) {
        throw new Error("simulated analyzer failure");
    }
    return realAnalyzeAsync(code, options);
});
delete require.cache[require.resolve("../src/analyze")];
const { analyzeDirectory } = require("../src/analyze");

const SOURCES = {
    "ok.js": "export const a = 1;\n",
    "run.js": "const cp = require('child_process');\ncp.exec('ls');\n",
    "broken.js": "function (\n",
    "a/broken.ts": "export function f(: number {\n",
    "b/broken.ts": "export function f(: number {\n",
    "B/Broken.ts": "export const x = ;\n",
    "dialect.ts": "export const App = () => <div>hi</div>;\n",
    "garbage.mjs": "\u0000\u0001\u0002 \uFFFD\uFFFD {{{ ]]] \n",
    "empty.cts": "",
    "ž/broken.tsx": "export const A = () => <div>;\n",
    "fine.tsx": "export const A = () => <div>ok</div>;\n",
    "explode.js": "export const b = 2;\n"
};

let dir;
// "B/Broken.ts" and "b/broken.ts" are the same file on case-insensitive file
// systems (Windows, default macOS); there it is not created.
let caseSensitive;
const LIMITS = { maxFiles: 500, maxFileBytes: 1024 * 1024 };

before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sirmcp-summary-")));
    fs.writeFileSync(path.join(dir, "case-probe"), "");
    caseSensitive = !fs.existsSync(path.join(dir, "CASE-PROBE"));
    fs.rmSync(path.join(dir, "case-probe"));
    for (const [rel, text] of Object.entries(SOURCES)) {
        if (rel === "B/Broken.ts" && !caseSensitive) continue;
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
});

after(() => {
    mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
});

function assertConsistent(out) {
    const paths = out.files.map((f) => f.path);
    assert.equal(new Set(paths).size, paths.length, "files has no duplicates");
    assert.equal(out.analyzed, out.files.length);
    assert.equal(out.statusCounts.complete + out.statusCounts.incomplete, out.analyzed);
    assert.equal(Object.values(out.riskCounts).reduce((a, b) => a + b, 0), out.analyzed);

    const expected = out.files.filter((f) => f.analysisStatus !== "complete").map((f) => f.path);
    assert.equal(new Set(out.incomplete).size, out.incomplete.length, "incomplete has no duplicates");
    assert.deepEqual([...out.incomplete].sort(), [...expected].sort(), "incomplete lists exactly the incomplete files");
    assert.deepEqual(out.incomplete, [...out.incomplete].sort(), "incomplete is sorted by path");
    assert.equal(out.statusCounts.incomplete, out.incomplete.length);
    assert.equal(out.statusCounts.complete, out.files.filter((f) => f.analysisStatus === "complete").length);

    for (const p of out.skipped.unreadable) {
        assert.ok(!paths.includes(p), `${p} is not both unreadable and analyzed`);
        assert.ok(!out.incomplete.includes(p), `${p} is not both unreadable and incomplete`);
    }
}

test("parse failures are counted once, sorted, and add up to analyzed", async () => {
    const out = await analyzeDirectory(".", [dir], LIMITS);
    assertConsistent(out);
    const extra = caseSensitive ? 1 : 0;
    assert.deepEqual(out.incomplete, [
        ...(caseSensitive ? ["B/Broken.ts"] : []), "a/broken.ts", "b/broken.ts", "broken.js", "dialect.ts", "garbage.mjs", "ž/broken.tsx"
    ]);
    assert.deepEqual(out.statusCounts, { complete: 4, incomplete: 6 + extra });
    assert.equal(out.analyzed, 10 + extra);
    assert.deepEqual(out.skipped.unreadable, ["explode.js"]);
});

test("the summary is identical across repeated runs", async () => {
    const first = await analyzeDirectory(".", [dir], LIMITS);
    for (let i = 0; i < 3; i++) assert.deepEqual(await analyzeDirectory(".", [dir], LIMITS), first);
});

test("a file that cannot be read is listed in skipped.unreadable, not counted", async (t) => {
    const realOpen = fsp.open;
    const readMock = t.mock.method(fsp, "open", (file, ...rest) => {
        if (String(file).endsWith(`${path.sep}run.js`)) {
            return Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
        }
        return realOpen.call(fsp, file, ...rest);
    });
    const out = await analyzeDirectory(".", [dir], LIMITS);
    readMock.mock.restore();
    assertConsistent(out);
    assert.deepEqual(out.skipped.unreadable, ["explode.js", "run.js"]);
    const extra = caseSensitive ? 1 : 0;
    assert.equal(out.analyzed, 9 + extra);
    assert.equal(out.riskCounts.critical, 0, "the unreadable file is not reported with any risk");
    assert.deepEqual(out.statusCounts, { complete: 3, incomplete: 6 + extra });
});

test("max_files truncation keeps counts consistent", async () => {
    for (const maxFiles of [1, 2, 3, 5, 8]) {
        const out = await analyzeDirectory(".", [dir], { ...LIMITS, maxFiles });
        assertConsistent(out);
        assert.equal(out.truncated, true);
        assert.equal(out.analyzed + out.skipped.unreadable.length, maxFiles);
    }
});

test("a real unreadable file (chmod 000) is skipped", { skip: (process.platform === "win32" && "chmod 000 does not block reads on Windows") || (process.getuid?.() === 0 && "root can read mode 000 files") }, async () => {
    const sub = fs.mkdtempSync(path.join(dir, "perm-"));
    fs.writeFileSync(path.join(sub, "locked.js"), "require('child_process').exec('x');\n");
    fs.writeFileSync(path.join(sub, "open.js"), "export const a = 1;\n");
    fs.chmodSync(path.join(sub, "locked.js"), 0o000);
    try {
        const out = await analyzeDirectory(sub, [dir], LIMITS);
        assertConsistent(out);
        assert.deepEqual(out.skipped.unreadable, [`${path.basename(sub)}/locked.js`]);
        assert.deepEqual(out.files.map((f) => f.path), [`${path.basename(sub)}/open.js`]);
    } finally {
        fs.chmodSync(path.join(sub, "locked.js"), 0o644);
        fs.rmSync(sub, { recursive: true, force: true });
    }
});

test("a truncated scan counts the files it left out and warns that riskCounts are partial", async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), "sir-trunc-"));
    try {
        for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(big, `a${String(i).padStart(2, "0")}.js`), `export const a${i} = ${i};\n`);
        fs.mkdirSync(path.join(big, "zz"));
        for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(big, "zz", `evil${i}.js`), "require('child_process').exec(process.argv[2]);\n");
        const part = await analyzeDirectory(".", [big], { ...LIMITS, maxFiles: 50 });
        assert.equal(part.truncated, true);
        assert.equal(part.notScanned, 5);
        assert.equal(part.riskCounts.critical, 0);
        assert.match(part.warning, /5 more source file\(s\) past max_files 50/);
        assert.match(part.warning, /not a clean result/);
        assert.equal(Object.keys(part)[1], "warning", "the warning comes before the counts");
        const all = await analyzeDirectory(".", [big], { ...LIMITS, maxFiles: 500 });
        assert.equal(all.truncated, false);
        assert.equal(all.notScanned, 0);
        assert.equal(all.warning, undefined);
        assert.equal(all.riskCounts.critical, 5);
    } finally { fs.rmSync(big, { recursive: true, force: true }); }
});

test("after max_files the walk looks at a bounded number of entries and says the count is a lower bound", async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), "sir-cap-"));
    try {
        fs.writeFileSync(path.join(big, "a.js"), "export const a = 1;\n");
        fs.writeFileSync(path.join(big, "b.js"), "export const b = 2;\n");
        fs.mkdirSync(path.join(big, "zz"));
        for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(big, "zz", `n${i}.txt`), "");
        fs.writeFileSync(path.join(big, "zz", "zzz.js"), "require('child_process').exec(process.argv[2]);\n");
        const part = await analyzeDirectory(".", [big], { ...LIMITS, maxFiles: 1 });
        assert.equal(part.analyzed, 1);
        assert.equal(part.truncated, true);
        assert.ok(part.notScanned >= 1);
        assert.match(part.warning, /at least \d+ more source file\(s\) past max_files 1/);
    } finally {
        fs.rmSync(big, { recursive: true, force: true });
    }
});

test("counting the files past max_files waits for the analysis and stops at the time budget", async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), "sir-late-"));
    try {
        for (const n of ["a.js", "b.js", "c.js"]) fs.writeFileSync(path.join(big, n), "export const x = 1;\n");
        const part = await analyzeDirectory(".", [big], { ...LIMITS, maxFiles: 1, timeBudgetMs: 0 });
        assert.equal(part.truncated, true);
        assert.equal(part.notScanned, 1);
        assert.match(part.warning, /at least 1 more source file\(s\) past max_files 1/);
    } finally {
        fs.rmSync(big, { recursive: true, force: true });
    }
});

test("empty folders before and after max_files do not stop the scan", async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), "sir-empty-"));
    try {
        fs.mkdirSync(path.join(big, "a-empty"));
        fs.mkdirSync(path.join(big, "b"));
        fs.writeFileSync(path.join(big, "b", "x.js"), "export const x = 1;\n");
        fs.mkdirSync(path.join(big, "c-empty"));
        fs.mkdirSync(path.join(big, "d"));
        fs.writeFileSync(path.join(big, "d", "y.js"), "export const y = 1;\n");
        const all = await analyzeDirectory(".", [big], LIMITS);
        assert.equal(all.analyzed, 2);
        fs.mkdirSync(path.join(big, "e-empty"));
        const part = await analyzeDirectory(".", [big], { ...LIMITS, maxFiles: 1 });
        assert.equal(part.analyzed, 1);
        assert.equal(part.notScanned, 1);
    } finally {
        fs.rmSync(big, { recursive: true, force: true });
    }
});
