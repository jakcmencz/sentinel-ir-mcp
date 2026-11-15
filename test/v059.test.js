"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const SentinelIR = require("sentinel-ir");
const { compress } = require("sentinel-ir");
const { summaryEntry } = require("../src/analyze");
const { describe } = require("../src/logView");
const { refusalReason } = require("../src/server");
const { plainPath } = require("../src/paths");

test("folder summary names the forbidden capability of a file that did not parse", async () => {
    const broken = summaryEntry("a.py", compress(await SentinelIR.analyzeAsync("import subprocess\ndef (:\n", { language: "python" })));
    assert.equal(broken.analysisStatus, "incomplete");
    assert.equal(broken.risk, "critical");
    assert.deepEqual(broken.forbidden, ["child_process"]);
    const clean = summaryEntry("b.py", compress(await SentinelIR.analyzeAsync("import os\nos.system('x')\n", { language: "python" })));
    assert.equal(clean.analysisStatus, "complete");
    assert.equal("forbidden" in clean, false);
});

test("audit log says unsupported language, not broken code, for an unknown extension", () => {
    const [unknown] = describe({ tool: "analyze_code", target: "x.rb", ok: true, risk: "low", analysisStatus: "incomplete", language: "unknown", bytes: 3 });
    assert.match(unknown, /\(incomplete: unsupported language\)/);
    const [broken] = describe({ tool: "analyze_code", target: "x.py", ok: true, risk: "low", analysisStatus: "incomplete", language: "python", bytes: 3 });
    assert.match(broken, /\(incomplete: broken code\)/);
});

test("a file:// URL to another machine is logged with a short reason", () => {
    let err;
    try { plainPath("file://host/share/x.js", "linux"); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(refusalReason(err), "url");
    const [line] = describe({ tool: "analyze_file", path: "file://host/share/x.js", ok: false, reason: "url", message: err.message });
    assert.match(line, /not a local file path/);
    assert.doesNotMatch(line, /is a URL/);
});

test("file: without // is refused as a URL; a folder is logged as not a file", () => {
    assert.throws(() => plainPath("file:src/server.js", "linux"), /is a URL/);
    assert.equal(refusalReason(Object.assign(new (require("../src/paths").AccessError)("Not a file: src"), {})), "not-a-file");
    const [line] = describe({ tool: "analyze_file", path: "src", ok: false, reason: "not-a-file", message: "Not a file: src" });
    assert.match(line, /not a file/);
});

test("analyze_code accepts the py and rs language aliases", async () => {
    const { analyzeCode } = require("../src/analyze");
    const py = await analyzeCode("import os\nos.system('x')\n", undefined, "py");
    assert.equal(py.language, "python");
    const rs = await analyzeCode("fn main() {}\n", undefined, "rs");
    assert.equal(rs.language, "rust");
});

test("remote file:// and http URLs are refused as URLs", () => {
    const { plainPath: plain } = require("../src/paths");
    for (const p of ["file://server/share/x.js", "https://example.com/x.js"]) {
        assert.throws(() => plain(p, "win32"), /is a URL/, p);
        assert.throws(() => plain(p, "linux"), /is a URL/, p);
    }
    assert.equal(plain("file://localhost/C:/p/x.js", "win32"), "C:\\p\\x.js");
});

test("Windows: a UNC path outside the folders is refused before any file system call", { skip: process.platform !== "win32" }, () => {
    const fs = require("fs");
    const { resolveInside } = require("../src/paths");
    const calls = [];
    const orig = { realpathSync: fs.realpathSync, lstatSync: fs.lstatSync };
    fs.realpathSync = (p) => { calls.push(p); throw new Error("touched"); };
    fs.lstatSync = (p) => { calls.push(p); throw new Error("touched"); };
    try {
        for (const p of ["//192.0.2.55/share/x.js", "\\\\192.0.2.55\\share\\x.js"]) {
            assert.throws(() => resolveInside(p, ["C:\\proj"]), /outside the allowed folders/, p);
        }
    } finally {
        Object.assign(fs, orig);
    }
    assert.deepEqual(calls, []);
});

test("log splits hard links from too-large files and names not-a-folder", () => {
    const [line] = describe({ tool: "analyze_directory", path: ".", ok: true, analyzed: 9, riskCounts: { low: 9 }, notRead: 4, hardlinks: 3 });
    assert.match(line, /1 not read \(too large or unreadable\), 3 not read \(several hard links\)/);
    const [ref] = describe({ tool: "analyze_directory", path: "a.js", ok: false, reason: "not-a-folder", message: "Not a folder: a.js" });
    assert.match(ref, /not a folder/);
});
