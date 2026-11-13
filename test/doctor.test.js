"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCommand } = require("../src/cli");
const { entryFolders } = require("../src/doctor");

function sandbox() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-doctor-")));
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "run.js"), 'require("child_process").exec("ls");\n');
    return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function run(sb, command, argv, extra = {}) {
    let stdout = "";
    let stderr = "";
    const io = {
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
        env: { HOME: sb.home, ...(extra.env || {}) }, platform: extra.platform || "linux", cwd: extra.cwd || sb.project, isTTY: false, prompt: null,
        now: () => Date.UTC(2026, 9, 18), nodeVersion: extra.nodeVersion
    };
    const code = await runCommand(command, argv, io);
    return { code, stdout, stderr };
}

const doctorJson = async (sb, argv, extra) => {
    const r = await run(sb, "doctor", [...argv, "--json"], extra);
    return { code: r.code, report: JSON.parse(r.stdout) };
};
const byId = (report, id) => report.checks.filter((c) => c.id === id);

test("doctor after setup: real handshake, exactly three tools, analyze_directory call, exit 0", async () => {
    const sb = sandbox();
    try {
        assert.equal((await run(sb, "setup", ["--client", "windsurf", "--yes"])).code, 0);
        const { code, report } = await doctorJson(sb, ["--client", "windsurf"], { cwd: sb.base });
        assert.equal(code, 0, JSON.stringify(report, null, 2));
        assert.equal(report.ok, true);
        assert.equal(byId(report, "node")[0].status, "ok");
        assert.match(byId(report, "windsurf.entry")[0].message, /sentinel-ir-mcp@0\.5/);
        assert.equal(byId(report, "mcp.handshake")[0].status, "ok");
        assert.equal(byId(report, "mcp.tools")[0].message, "Tools: analyze_code, analyze_directory, analyze_file");
        assert.ok(byId(report, "mcp.call")[0].message.includes(sb.project), "uses the folder from the config, not the cwd");
    } finally { sb.cleanup(); }
});

test("doctor resolves ${workspaceFolder} in a Cursor project config", async () => {
    const sb = sandbox();
    try {
        assert.equal((await run(sb, "setup", ["--client", "cursor", "--yes"])).code, 0);
        const { code, report } = await doctorJson(sb, ["--client", "cursor"]);
        assert.equal(code, 0, JSON.stringify(report, null, 2));
        assert.ok(byId(report, "mcp.call")[0].message.includes(sb.project));
    } finally { sb.cleanup(); }
});

test("doctor exits 1 with a fix for a missing config, a missing entry, invalid JSON, a wrong entry or a missing folder", async () => {
    const sb = sandbox();
    try {
        const file = path.join(sb.home, ".config", "devin", "mcp_config.json");
        const expectFail = async (id, pattern) => {
            const { code, report } = await doctorJson(sb, ["--client", "windsurf"]);
            assert.equal(code, 1, id);
            const failed = report.checks.filter((c) => c.status === "fail");
            assert.ok(failed.some((c) => c.id === id && pattern.test(c.message) && c.fix), `${id}: ${JSON.stringify(failed)}`);
        };
        await expectFail("windsurf.config", /not found/);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{"mcpServers": {"other": {"command": "x"}}}');
        await expectFail("windsurf.entry", /no "sentinel-ir"/);
        fs.writeFileSync(file, "{ nope");
        await expectFail("windsurf.config", /not valid JSON/);
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "rm", args: ["-rf", "/"] } } }));
        await expectFail("windsurf.entry", /does not start sentinel-ir-mcp/);
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp@0.5", path.join(sb.base, "gone")] } } }));
        await expectFail("windsurf.folder", /does not exist/);
    } finally { sb.cleanup(); }
});

test("doctor never runs the command stored in the client config", async () => {
    const sb = sandbox();
    try {
        const marker = path.join(sb.base, "ran");
        const file = path.join(sb.home, ".config", "devin", "mcp_config.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const evil = path.join(sb.base, "evil.js");
        fs.writeFileSync(evil, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: process.execPath, args: [evil, "sentinel-ir-mcp", sb.project] } } }));
        const { code, report } = await doctorJson(sb, ["--client", "windsurf"]);
        assert.equal(byId(report, "windsurf.entry")[0].status, "warn");
        assert.equal(code, 0, "own server still answers");
        assert.equal(fs.existsSync(marker), false);
    } finally { sb.cleanup(); }
});

test("doctor without a client checks configs it finds and the project folder; text output", async () => {
    const sb = sandbox();
    try {
        const r = await run(sb, "doctor", []);
        assert.equal(r.code, 0, r.stdout);
        assert.match(r.stdout, /\[skip\] Windsurf: no config/);
        assert.match(r.stdout, /\[ok\] {3}Tools: analyze_code, analyze_directory, analyze_file/);
        assert.match(r.stdout, /All checks passed/);
        const missing = await run(sb, "doctor", ["--project", path.join(sb.base, "nope")]);
        assert.equal(missing.code, 1);
        assert.match(missing.stdout, /\[FAIL\] Project folder/);
    } finally { sb.cleanup(); }
});

test("entryFolders skips flags and their values", () => {
    assert.deepEqual(entryFolders(["-y", "sentinel-ir-mcp@0.5", "--max-files", "5", "/a", "--max-file-bytes=9", "/b"]), ["/a", "/b"]);
    assert.deepEqual(entryFolders(["-y", "sentinel-ir-mcp"]), []);
    assert.equal(entryFolders(["-y", "other-server"]), null);
});

test("doctor fails with exit 1 on Node.js older than 20", async () => {
    const sb = sandbox();
    try {
        const { code, report } = await doctorJson(sb, [], { nodeVersion: "18.19.0" });
        assert.equal(code, 1);
        assert.deepEqual(byId(report, "node")[0], { status: "fail", id: "node", message: "Node.js v18.19.0 is too old", fix: "Install Node.js 20 or newer." });
    } finally { sb.cleanup(); }
});

test("doctor on Windows (simulated): cmd /c npx is ok, plain npx gets a warning", async () => {
    const sb = sandbox();
    try {
        const appdata = path.join(sb.base, "AppData", "Roaming");
        const file = path.join(appdata, "Claude", "claude_desktop_config.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const win = { platform: "win32", env: { APPDATA: appdata } };
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "cmd", args: ["/c", "npx", "-y", "sentinel-ir-mcp@0.5", sb.project] } } }));
        let { code, report } = await doctorJson(sb, ["--client", "claude-desktop"], win);
        assert.equal(code, 0);
        assert.equal(byId(report, "claude-desktop.entry")[0].status, "ok");
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp@0.5", sb.project] } } }));
        ({ code, report } = await doctorJson(sb, ["--client", "claude-desktop"], win));
        assert.equal(code, 0);
        assert.equal(byId(report, "claude-desktop.entry")[0].status, "warn");
        assert.match(byId(report, "claude-desktop.entry")[0].fix, /setup --client claude-desktop/);
    } finally { sb.cleanup(); }
});

test("doctor reads an old ~/.codeium Windsurf config and warns that it moved", async () => {
    const sb = sandbox();
    try {
        const legacy = path.join(sb.home, ".codeium", "windsurf", "mcp_config.json");
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp@0.5", sb.project] } } }));
        const { code, report } = await doctorJson(sb, ["--client", "windsurf"]);
        assert.equal(code, 0);
        assert.equal(byId(report, "windsurf.location")[0].status, "warn");
        assert.match(byId(report, "windsurf.location")[0].fix, /\.config.devin.mcp_config\.json/);
        assert.equal(byId(report, "windsurf.entry")[0].status, "ok");
    } finally { sb.cleanup(); }
});

test("doctor warns about entries pinned to 0.4 or older and accepts 0.5", async () => {
    const sb = sandbox();
    try {
        const file = path.join(sb.home, ".cursor", "mcp.json");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        for (const [spec, status] of [["sentinel-ir-mcp@0.2", "warn"], ["sentinel-ir-mcp@0.3", "warn"], ["sentinel-ir-mcp@0.3.0", "warn"], ["sentinel-ir-mcp@0.4", "warn"], ["sentinel-ir-mcp@0.4.6", "warn"], ["sentinel-ir-mcp@0.5", "ok"]]) {
            fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", spec, sb.project] } } }));
            const { report } = await doctorJson(sb, ["--client", "cursor", "--global"]);
            const entry = byId(report, "cursor.entry")[0];
            assert.equal(entry.status, status, spec);
            if (status === "warn") assert.match(entry.fix, /sentinel-ir-mcp@0\.5 setup --client cursor/);
        }
    } finally { sb.cleanup(); }
});
