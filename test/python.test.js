"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeFixture, connectStdio, call } = require("./helpers");

const PY_SOURCES = {
    "py/app.py": `from flask import Flask\nimport requests\napp = Flask(__name__)\n@app.get("/health")\ndef health():\n    return requests.get("https://example.com").text\n`,
    "py/run.py": `import subprocess as sp\ndef run(cmd):\n    sp.run(cmd, shell=True)\n`,
    "py/load.py": `import pickle\ndef load(b):\n    return pickle.loads(b)\n`,
    "py/stubs.pyi": `def f(x: int) -> int: ...\n`,
    "py/broken.py": `def f(:\n`,
    "py/__pycache__/cached.py": `import os\nos.system("x")\n`,
    "venv/lib/site.py": `import os\nos.system("x")\n`
};

let fx;
let client;

before(async () => {
    fx = makeFixture();
    for (const [rel, text] of Object.entries(PY_SOURCES)) {
        fs.mkdirSync(path.dirname(path.join(fx.project, rel)), { recursive: true });
        fs.writeFileSync(path.join(fx.project, rel), text);
    }
    client = await connectStdio([fx.project]);
});

after(async () => {
    await client?.close();
    fx?.cleanup();
});

test("analyze_file picks the Python grammar from .py and .pyi", async () => {
    const run = (await call(client, "analyze_file", { path: "py/run.py" })).structuredContent;
    assert.equal(run.language, "python");
    assert.equal(run.analysisStatus, "complete");
    assert.equal(run.world.risk, "critical");
    assert.deepEqual(run.forbidden, ["child_process", "process_spawn"]);
    const stub = (await call(client, "analyze_file", { path: "py/stubs.pyi" })).structuredContent;
    assert.equal(stub.language, "python");
    assert.equal(stub.world.risk, "low");
});

test("analyze_code accepts language python and a .py target", async () => {
    const byLanguage = (await call(client, "analyze_code", { code: "import pickle\npickle.loads(b)", language: "python" })).structuredContent;
    assert.equal(byLanguage.world.risk, "critical");
    assert.deepEqual(byLanguage.forbidden, ["unsafe_deserialization"]);
    const byTarget = (await call(client, "analyze_code", { code: "x = 1", target: "a.py" })).structuredContent;
    assert.equal(byTarget.language, "python");
});

test("analyze_directory includes Python files and skips __pycache__ and venv", async () => {
    const result = (await call(client, "analyze_directory", {})).structuredContent;
    const rows = result.files.filter(f => /^(py|venv)\//.test(f.path)).map(f => [f.path, f.language, f.risk, f.analysisStatus]);
    assert.deepEqual(rows, [
        ["py/load.py", "python", "critical", "complete"],
        ["py/run.py", "python", "critical", "complete"],
        ["py/app.py", "python", "medium", "complete"],
        ["py/broken.py", "python", "low", "incomplete"],
        ["py/stubs.pyi", "python", "low", "complete"]
    ]);
    assert.ok(result.incomplete.includes("py/broken.py"));
    const inPy = (await call(client, "analyze_directory", { path: "py" })).structuredContent;
    assert.deepEqual(inPy.statusCounts, { complete: 4, incomplete: 1 });
});
