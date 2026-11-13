"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeFixture, connectStdio, call } = require("./helpers");

const TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n";
const RS_SOURCES = {
    "rs/src/main.rs": `use std::process::Command;\nfn main() { Command::new("sh").arg("-c").arg("id").status().unwrap(); }\n`,
    "rs/src/net.rs": `pub async fn get() -> reqwest::Result<String> { reqwest::get("https://example.com").await?.text().await }\n`,
    "rs/src/ffi.rs": `extern "C" { fn abs(x: i32) -> i32; }\npub fn f() -> i32 { unsafe { abs(-1) } }\n`,
    "rs/src/broken.rs": `fn f( {\n`,
    "rs/src/lib.rs": `pub fn add(a: i32, b: i32) -> i32 { a + b }\n`,
    "rs/build.rs": `fn main() { let _ = std::fs::read_to_string("/etc/passwd"); }\n`,
    "rs/target/CACHEDIR.TAG": TAG,
    "rs/target/debug/build/out.rs": `fn main() { std::process::Command::new("x"); }\n`,
    "web/target/app.js": `require("child_process").exec("x");\n`,
    "fake/target/CACHEDIR.TAG": "not a cargo tag\n",
    "fake/target/hidden.rs": `fn main() { std::process::Command::new("x"); }\n`
};

let fx;
let client;

before(async () => {
    fx = makeFixture();
    for (const [rel, text] of Object.entries(RS_SOURCES)) {
        fs.mkdirSync(path.dirname(path.join(fx.project, rel)), { recursive: true });
        fs.writeFileSync(path.join(fx.project, rel), text);
    }
    client = await connectStdio([fx.project]);
});

after(async () => {
    await client?.close();
    fx?.cleanup();
});

test("analyze_file picks the Rust grammar from .rs", async () => {
    const main = (await call(client, "analyze_file", { path: "rs/src/main.rs" })).structuredContent;
    assert.equal(main.language, "rust");
    assert.equal(main.analysisStatus, "complete");
    assert.equal(main.world.risk, "critical");
    const build = (await call(client, "analyze_file", { path: "rs/build.rs" })).structuredContent;
    assert.equal(build.world.risk, "high", "build.rs reading files runs at compile time");
});

test("analyze_code accepts language rust and a .rs target", async () => {
    const byLanguage = (await call(client, "analyze_code", { code: "fn f() { unsafe { std::ptr::null::<u8>().read(); } }", language: "rust" })).structuredContent;
    assert.equal(byLanguage.language, "rust");
    assert.equal(byLanguage.world.risk, "critical");
    const byTarget = (await call(client, "analyze_code", { code: "fn f() {}", target: "a.rs" })).structuredContent;
    assert.equal(byTarget.language, "rust");
    assert.equal(byTarget.world.risk, "low");
});

test("analyze_directory includes Rust files and skips only Cargo's tagged target folder", async () => {
    const result = (await call(client, "analyze_directory", {})).structuredContent;
    const rows = result.files.map((f) => [f.path, f.language, f.risk, f.analysisStatus]);
    for (const row of [
        ["rs/src/main.rs", "rust", "critical", "complete"],
        ["rs/src/ffi.rs", "rust", "critical", "complete"],
        ["rs/build.rs", "rust", "high", "complete"],
        ["rs/src/net.rs", "rust", "medium", "complete"],
        ["rs/src/lib.rs", "rust", "low", "complete"],
        ["rs/src/broken.rs", "rust", "low", "incomplete"],
        ["web/target/app.js", "javascript", "critical", "complete"],
        ["fake/target/hidden.rs", "rust", "critical", "complete"]
    ]) assert.deepEqual(rows.find((r) => r[0] === row[0]), row);
    assert.ok(!rows.some((r) => r[0].startsWith("rs/target/")));
    assert.deepEqual(result.skipped.cargoTarget, ["rs/target"]);
    assert.ok(result.incomplete.includes("rs/src/broken.rs"));
});

test("analyze_file still reads a file inside a Cargo target folder when asked", async () => {
    const out = (await call(client, "analyze_file", { path: "rs/target/debug/build/out.rs" })).structuredContent;
    assert.equal(out.language, "rust");
});

test("a symlinked CACHEDIR.TAG does not hide a folder", { skip: process.platform === "win32" }, async () => {
    const dir = path.join(fx.project, "link", "target");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(fx.project, "rs", "target", "CACHEDIR.TAG"), path.join(dir, "CACHEDIR.TAG"));
    fs.writeFileSync(path.join(dir, "x.rs"), "fn f() {}\n");
    const result = (await call(client, "analyze_directory", { path: "link" })).structuredContent;
    assert.deepEqual(result.files.map((f) => f.path), ["link/target/x.rs"]);
    assert.deepEqual(result.skipped.cargoTarget, []);
});
