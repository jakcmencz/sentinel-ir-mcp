"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { releaseNotes } = require("../scripts/release-notes");
const { version } = require("../package.json");

const README = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");

test("the README has release notes for the package version", () => {
    const notes = releaseNotes(README, version);
    assert.ok(notes, `README.md needs a "**${version}**" section`);
    assert.ok(notes.startsWith(`**${version}**`));
    assert.match(notes, new RegExp(`npmjs\\.com/package/sentinel-ir-mcp/v/${version.replace(/\./g, "\\.")}\\n`));
});

test("notes stop before the next version and before a heading", () => {
    const readme = "intro\n\n**1.2.3** new\n- a\r\n\n**1.2.2** old\n- b\n";
    const notes = releaseNotes(readme, "1.2.3");
    assert.ok(notes.startsWith("**1.2.3** new\n- a\n"));
    assert.ok(!notes.includes("1.2.2"));
    assert.ok(!releaseNotes("**1.0.0** x\n## Tools\n- t\n", "1.0.0").includes("Tools"));
});

test("an unknown or prefix-only version has no notes", () => {
    assert.equal(releaseNotes("**1.2.30** x\n", "1.2.3"), null);
    assert.equal(releaseNotes(README, "9.9.9"), null);
});
