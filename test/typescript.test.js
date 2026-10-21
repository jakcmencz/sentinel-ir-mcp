"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeFixture, connectStdio, call } = require("./helpers");

const TS_SOURCES = {
    "ts/server.ts": `import express from "express";\nimport type { Request } from "express";\nconst app = express();\napp.get("/health", (req: Request, res: any) => res.send("ok"));\nexport default app;\n`,
    "ts/run.cts": `import cp = require("child_process");\nexport function run(cmd: string): void { (cp as any).exec(cmd); }\n`,
    "ts/types.d.ts": `import type { ChildProcess } from "child_process";\nexport interface Job { proc: ChildProcess }\n`,
    "ts/App.tsx": `export const App = () => <button onClick={() => fetch("/api")}>go</button>;\n`,
    "ts/broken.ts": `export function (: number {\n`
};

let fx;
let client;

before(async () => {
    fx = makeFixture();
    for (const [rel, text] of Object.entries(TS_SOURCES)) {
        fs.mkdirSync(path.dirname(path.join(fx.project, rel)), { recursive: true });
        fs.writeFileSync(path.join(fx.project, rel), text);
    }
    client = await connectStdio([fx.project]);
});

after(async () => {
    await client?.close();
    fx?.cleanup();
});

test("analyze_file picks the TypeScript grammar from the extension", async () => {
    const run = (await call(client, "analyze_file", { path: "ts/run.cts" })).structuredContent;
    assert.equal(run.language, "typescript");
    assert.equal(run.analysisStatus, "complete");
    assert.equal(run.world.risk, "critical");
    assert.deepEqual(run.forbidden, ["child_process", "process_spawn"]);

    const app = (await call(client, "analyze_file", { path: "ts/App.tsx" })).structuredContent;
    assert.equal(app.language, "tsx");
    assert.deepEqual(app.facts.calls.network, ["fetch"]);

    const types = (await call(client, "analyze_file", { path: "ts/types.d.ts" })).structuredContent;
    assert.equal(types.world.risk, "low", "type-only import is not a runtime import");
});

test("broken TypeScript is reported as incomplete", async () => {
    const r = (await call(client, "analyze_file", { path: "ts/broken.ts" })).structuredContent;
    assert.equal(r.analysisStatus, "incomplete");
    assert.equal(r.facts.ast, false);
});

test("analyze_code accepts a language or infers it from target", async () => {
    const byTarget = (await call(client, "analyze_code", { code: "const x: number = 1;", target: "x.ts" })).structuredContent;
    assert.equal(byTarget.language, "typescript");
    assert.equal(byTarget.analysisStatus, "complete");

    const explicit = (await call(client, "analyze_code", { code: "const x: number = 1;", language: "typescript" })).structuredContent;
    assert.equal(explicit.analysisStatus, "complete");

    const plain = (await call(client, "analyze_code", { code: "const x: number = 1;" })).structuredContent;
    assert.equal(plain.language, "javascript");
    assert.equal(plain.analysisStatus, "incomplete", "TypeScript read as JavaScript must not look complete");

    const bad = await call(client, "analyze_code", { code: "x", language: "python" });
    assert.equal(bad.isError, true);
});

test("analyze_directory includes TypeScript files with their language", async () => {
    const out = (await call(client, "analyze_directory", { path: "ts" })).structuredContent;
    assert.deepEqual(out.files.map((f) => [f.path, f.language, f.risk, f.analysisStatus]), [
        ["ts/run.cts", "typescript", "critical", "complete"],
        ["ts/App.tsx", "tsx", "medium", "complete"],
        ["ts/server.ts", "typescript", "medium", "complete"],
        ["ts/broken.ts", "typescript", "low", "incomplete"],
        ["ts/types.d.ts", "typescript", "low", "complete"]
    ]);
    assert.deepEqual(out.statusCounts, { complete: 4, incomplete: 1 });
    assert.deepEqual(out.incomplete, ["ts/broken.ts"], "an incomplete file is surfaced even though it sorts last by risk");
});
