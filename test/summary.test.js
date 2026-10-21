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
const LIMITS = { maxFiles: 500, maxFileBytes: 1024 * 1024 };

before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sirmcp-summary-")));
    for (const [rel, text] of Object.entries(SOURCES)) {
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
    assert.deepEqual(out.incomplete, [
        "B/Broken.ts", "a/broken.ts", "b/broken.ts", "broken.js", "dialect.ts", "garbage.mjs", "ž/broken.tsx"
    ]);
    assert.deepEqual(out.statusCounts, { complete: 4, incomplete: 7 });
    assert.equal(out.analyzed, 11);
    assert.deepEqual(out.skipped.unreadable, ["explode.js"]);
});

test("the summary is identical across repeated runs", async () => {
    const first = await analyzeDirectory(".", [dir], LIMITS);
    for (let i = 0; i < 3; i++) assert.deepEqual(await analyzeDirectory(".", [dir], LIMITS), first);
});

test("a file that cannot be read is listed in skipped.unreadable, not counted", async (t) => {
    const realReadFile = fsp.readFile;
    const readMock = t.mock.method(fsp, "readFile", (file, ...rest) => {
        if (String(file).endsWith(`${path.sep}run.js`)) {
            return Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
        }
        return realReadFile.call(fsp, file, ...rest);
    });
    const out = await analyzeDirectory(".", [dir], LIMITS);
    readMock.mock.restore();
    assertConsistent(out);
    assert.deepEqual(out.skipped.unreadable, ["explode.js", "run.js"]);
    assert.equal(out.analyzed, 10);
    assert.equal(out.riskCounts.critical, 0, "the unreadable file is not reported with any risk");
    assert.deepEqual(out.statusCounts, { complete: 3, incomplete: 7 });
});

test("max_files truncation keeps counts consistent", async () => {
    for (const maxFiles of [1, 2, 3, 5, 8]) {
        const out = await analyzeDirectory(".", [dir], { ...LIMITS, maxFiles });
        assertConsistent(out);
        assert.equal(out.truncated, true);
        assert.equal(out.analyzed + out.skipped.unreadable.length, maxFiles);
    }
});

test("a real unreadable file (chmod 000) is skipped", { skip: process.getuid?.() === 0 && "root can read mode 000 files" }, async () => {
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
