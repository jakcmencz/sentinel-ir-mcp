"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const BIN = path.join(__dirname, "..", "bin", "sentinel-ir-mcp.js");

const SOURCES = {
    "server.js": `const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.send("ok"));\nmodule.exports = app;\n`,
    "danger.js": `const cp = require("child_process");\nmodule.exports = (cmd) => { eval(cmd); cp.exec(cmd); };\n`,
    "lib/util.mjs": `export function add(a, b) { return a + b; }\n`,
    "lib/deep/files.cjs": `const fs = require("fs");\nexports.wipe = (p) => fs.rmSync(p);\n`,
    "notes.txt": "not javascript",
    "node_modules/pkg/index.js": `eval("1")`,
    ".hidden/secret.js": `eval("1")`,
    ".git/hook.js": `eval("1")`
};

// A project folder plus a sibling "outside" folder the server must never read.
function makeFixture() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-mcp-")));
    const project = path.join(base, "project");
    const outside = path.join(base, "outside");
    for (const [rel, text] of Object.entries(SOURCES)) {
        const file = path.join(project, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "private.js"), `module.exports = "outside";\n`);
    fs.symlinkSync(path.join(outside, "private.js"), path.join(project, "link-to-outside.js"));
    fs.symlinkSync(outside, path.join(project, "linked-dir"));
    return { base, project, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function connectStdio(args = []) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...args], stderr: "pipe" });
    const client = new Client({ name: "sentinel-ir-mcp-test", version: "0.0.0" });
    await client.connect(transport);
    return client;
}

async function call(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, text: result.content[0].text };
}

module.exports = { BIN, makeFixture, connectStdio, call };
