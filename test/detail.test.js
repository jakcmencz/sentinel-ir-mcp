"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeFixture, connectStdio, call } = require("./helpers");
const { summaryEntry } = require("../src/analyze");

let fx;
let client;
const LONG = "a".repeat(5000);

before(async () => {
    fx = makeFixture();
    const add = (name, text) => fs.writeFileSync(path.join(fx.project, name), text);
    add("many.js", "eval(a);\neval(b);\neval(c);\neval(d);\neval(e);\n");
    add("long.js", `const cp = require("child_process");\nconst ${LONG} = cp;\n${LONG}.exec(x);\n`);
    add("broken2.js", "const a = (1;\n");
    add("crypto-utils.js", "module.exports = 1;\n");
    client = await connectStdio([fx.project]);
});

after(async () => {
    await client.close();
    fx.cleanup();
});

const byPath = (out) => Object.fromEntries(out.files.map((f) => [f.path, f]));

test("analyze_directory returns short entries by default", async () => {
    const out = (await call(client, "analyze_directory", {})).structuredContent;
    assert.equal(out.detail, "summary");
    const danger = byPath(out)["danger.js"];
    assert.deepEqual(Object.keys(danger),
        ["path", "risk", "analysisStatus", "language", "lines", "operations", "riskSignals"]);
    assert.equal(danger.risk, "critical");
    assert.deepEqual(danger.operations, ["dynamicEval", "processSpawn", "childProcess"]);
    assert.deepEqual(danger.riskSignals,
        ["child_process_import:require(child_process)@1", "dynamic_code:eval@2", "process_spawn:cp.exec@2"]);
    for (const f of out.files) assert.ok(!("facts" in f) && !("forbidden" in f), f.path);
});

test("riskSignals only hold signals of the file's risk level", async () => {
    const out = (await call(client, "analyze_directory", {})).structuredContent;
    const levels = { medium: /^(disk_write|outbound_http|inbound_http|crypto_use|secret_comparison):/, high: /^destructive_fs:/ };
    for (const f of out.files.filter((x) => levels[x.risk])) {
        for (const s of f.riskSignals) assert.match(s, levels[f.risk], f.path);
    }
    assert.deepEqual(byPath(out)["lib/deep/files.cjs"].riskSignals, ["destructive_fs:fs.rmSync@2"]);
});

test("at most 3 signals, the rest counted; long code is cut, kind and line kept", async () => {
    const files = byPath((await call(client, "analyze_directory", {})).structuredContent);
    assert.deepEqual(files["many.js"].riskSignals, ["dynamic_code:eval@1", "dynamic_code:eval@2", "dynamic_code:eval@3"]);
    assert.equal(files["many.js"].moreRiskSignals, 2);
    const spawn = files["long.js"].riskSignals.find((s) => s.startsWith("process_spawn:"));
    assert.ok(spawn.length <= 120, String(spawn.length));
    assert.match(spawn, /^process_spawn:a+\u2026@3$/);
    assert.ok(!("moreRiskSignals" in files["danger.js"]));
});

test("an incomplete file carries its parseError; a risk without signals has none", async () => {
    const files = byPath((await call(client, "analyze_directory", {})).structuredContent);
    assert.equal(files["broken2.js"].analysisStatus, "incomplete");
    assert.deepEqual(files["broken2.js"].parseError, { line: 1, column: 13, kind: "missing", expected: ")" });
    assert.equal(files["crypto-utils.js"].risk, "medium");
    assert.deepEqual(files["crypto-utils.js"].riskSignals, []);
});

test("detail full keeps the 0.4.1 entries; both agree on order, risk and counts", async () => {
    const summary = (await call(client, "analyze_directory", {})).structuredContent;
    const full = (await call(client, "analyze_directory", { detail: "full" })).structuredContent;
    assert.equal(full.detail, "full");
    assert.deepEqual(Object.keys(byPath(full)["danger.js"]),
        ["path", "analysisStatus", "language", "risk", "objective", "forbidden", "lines", "facts"]);
    assert.deepEqual(summary.files.map((f) => [f.path, f.risk, f.analysisStatus]),
        full.files.map((f) => [f.path, f.risk, f.analysisStatus]));
    for (const key of ["analyzed", "riskCounts", "statusCounts", "incomplete", "skipped", "truncated"]) {
        assert.deepEqual(summary[key], full[key], key);
    }
    assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 2);
});

test("an unknown detail value is refused", async () => {
    const r = await call(client, "analyze_directory", { detail: "everything" });
    assert.equal(r.isError, true);
});

test("cutting code never splits a surrogate pair", () => {
    for (let pad = 0; pad < 4; pad++) {
        const signal = `process_spawn:${"x".repeat(90 + pad)}${"\u{1F600}".repeat(30)}.exec@7`;
        const ir = {
            analysisStatus: "complete", language: "javascript", world: { risk: "critical" },
            summary: { lines: 7 }, facts: { operations: ["processSpawn"], riskSignals: [signal] }
        };
        const [cut] = summaryEntry("a.js", ir).riskSignals;
        assert.ok(cut.length <= 120);
        assert.ok(cut.endsWith("\u2026@7"));
        assert.ok(cut.isWellFormed ? cut.isWellFormed() : !/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut), `pad ${pad}`);
    }
});
