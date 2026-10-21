"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const { BIN } = require("./helpers");
const pkg = require("../package.json");

const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("--version and --help", () => {
    assert.equal(run("--version").stdout.trim(), pkg.version);
    const help = run("--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: sentinel-ir-mcp/);
});

test("invalid arguments exit with code 2", () => {
    for (const args of [["--nope"], ["/definitely/not/here"], ["--max-files", "0"], ["--max-files=501"], ["--max-file-bytes", "abc"]]) {
        const r = run(...args);
        assert.equal(r.status, 2, args.join(" "));
        assert.match(r.stderr, /sentinel-ir-mcp:/);
    }
});

test("package metadata is publishable", () => {
    assert.equal(pkg.bin["sentinel-ir-mcp"], "bin/sentinel-ir-mcp.js");
    assert.equal(pkg.license, "Apache-2.0");
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@modelcontextprotocol/sdk", "sentinel-ir", "zod"]);
});
