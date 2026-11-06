"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { analyzeDirectory, readInside } = require("../src/analyze");
const { createServer, DEFAULT_LIMITS } = require("../src/server");
const { BIN, makeFixture, connectStdio, call } = require("./helpers");

const MARKER = "OUTSIDE_SECRET_MARKER";
const LIMITS = { maxFiles: 50, maxFileBytes: 1024 * 1024 };

function canSymlink(fx) {
    try {
        fs.symlinkSync(path.join(fx.outside, "private.js"), path.join(fx.project, "probe-link.js"));
        fs.unlinkSync(path.join(fx.project, "probe-link.js"));
        return true;
    } catch {
        return false;
    }
}

test("a file reached through a symlinked folder is refused at read time", async () => {
    const fx = makeFixture();
    try {
        await assert.rejects(readInside(path.join(fx.project, "linked-dir", "private.js"), [fx.project], 1024, "x"), /Access denied/);
        await assert.rejects(readInside(path.join(fx.project, "link-to-outside.js"), [fx.project], 1024, "x"), /Access denied/);
        assert.match(await readInside(path.join(fx.project, "server.js"), [fx.project], 1024, "x"), /express/);
    } finally {
        fx.cleanup();
    }
});

test("swapping a listed file for a symlink never leaks the outside file", async (t) => {
    const fx = makeFixture();
    try {
        if (!canSymlink(fx)) return t.skip("symlinks not permitted");
        const secret = path.join(fx.outside, "secret.js");
        fs.writeFileSync(secret, `module.exports.${MARKER} = 1;\n`);
        const race = path.join(fx.project, "race.js");
        let stop = false;
        let swaps = 0;
        (function swap() {
            if (stop) return;
            try {
                fs.rmSync(race, { force: true });
                if (swaps++ % 2) fs.symlinkSync(secret, race);
                else fs.writeFileSync(race, "module.exports.inside = 1;\n");
            } catch { /* the walker may hold it */ }
            setImmediate(swap);
        })();
        try {
            for (let i = 0; i < 300; i++) {
                const out = JSON.stringify(await analyzeDirectory(".", [fx.project], LIMITS));
                assert.ok(!out.includes(MARKER), `outside file leaked on run ${i}`);
            }
        } finally {
            stop = true;
        }
        assert.ok(swaps > 100, `only ${swaps} swaps`);
    } finally {
        fx.cleanup();
    }
});

test("a hard link to a file outside the folder is refused", async (t) => {
    const fx = makeFixture();
    try {
        const link = path.join(fx.project, "hard.js");
        try {
            fs.linkSync(path.join(fx.outside, "private.js"), link);
        } catch {
            return t.skip("hard links not permitted");
        }
        await assert.rejects(readInside(link, [fx.project], 1024, "hard.js"), /2 hard links/);
        const out = await analyzeDirectory(".", [fx.project], LIMITS);
        assert.deepEqual(out.skipped.hardlinks, ["hard.js"]);
        assert.ok(!out.files.some((f) => f.path === "hard.js"));
        assert.deepEqual(out.skipped.unreadable, []);
        const server = await connectStdio([fx.project]);
        try {
            const r = await call(server, "analyze_file", { path: "hard.js" });
            assert.equal(r.isError, true);
            assert.match(r.text, /hard links/);
        } finally {
            await server.close();
        }
    } finally {
        fx.cleanup();
    }
});

test("a FIFO at a listed path is refused without blocking", { skip: process.platform === "win32" }, async () => {
    const fx = makeFixture();
    try {
        const fifo = path.join(fx.project, "pipe.js");
        spawnSync("mkfifo", [fifo]);
        await assert.rejects(readInside(fifo, [fx.project], 1024, "pipe.js"), /Not a file/);
    } finally {
        fx.cleanup();
    }
});

test("analyze_directory stops starting files when the time budget is spent", async () => {
    const fx = makeFixture();
    try {
        const none = await analyzeDirectory(".", [fx.project], { ...LIMITS, timeBudgetMs: 0 });
        assert.equal(none.analyzed, 0);
        assert.equal(none.timedOut, true);
        assert.deepEqual(none.notAnalyzed.sort(), ["danger.js", "lib/deep/files.cjs", "lib/util.mjs", "server.js"]);

        const all = await analyzeDirectory(".", [fx.project], LIMITS);
        assert.equal(all.timedOut, false);
        assert.deepEqual(all.notAnalyzed, []);
        assert.equal(all.analyzed, 4);
    } finally {
        fx.cleanup();
    }
});

test("a file that grew past the limit after listing is reported as too large", async () => {
    const fx = makeFixture();
    try {
        await assert.rejects(readInside(path.join(fx.project, "server.js"), [fx.project], 10, "server.js"), /too large/);
        fs.writeFileSync(path.join(fx.project, "big.js"), "x".repeat(2000));
        const out = await analyzeDirectory(".", [fx.project], { ...LIMITS, maxFileBytes: 1000 });
        assert.ok(out.skipped.tooLarge.includes("big.js"));
    } finally {
        fx.cleanup();
    }
});

test("--max-file-bytes and --time-budget-ms have finite ceilings", () => {
    const run = (...args) => spawnSync(process.execPath, [BIN, ...args, "-v"], { encoding: "utf8" });
    assert.equal(run("--max-file-bytes", String(DEFAULT_LIMITS.hardMaxFileBytes)).status, 0);
    const over = run("--max-file-bytes", String(DEFAULT_LIMITS.hardMaxFileBytes + 1));
    assert.equal(over.status, 2);
    assert.match(over.stderr, /between 1 and 2097152/);
    assert.equal(run("--max-file-bytes=9007199254740991").status, 2);
    assert.equal(run("--time-budget-ms", "1000").status, 0);
    assert.equal(run("--time-budget-ms", "0").status, 2);
    assert.equal(run("--time-budget-ms", String(DEFAULT_LIMITS.hardMaxTimeBudgetMs + 1)).status, 2);
    assert.equal(run("--toString", "1").status, 2);
});

test("createServer clamps limits passed in code", () => {
    const server = createServer({ maxFileBytes: Number.MAX_SAFE_INTEGER, timeBudgetMs: 1e12 });
    const tools = server._registeredTools;
    assert.match(tools.analyze_file.description, /over 2097152 bytes/);
    assert.match(tools.analyze_directory.description, /after 600 s/);
});
