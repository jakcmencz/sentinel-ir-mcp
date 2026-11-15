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
    assert.doesNotMatch(line, /not a URL/);
});
