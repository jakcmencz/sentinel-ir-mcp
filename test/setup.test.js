"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runCommand } = require("../src/cli");
const { installLinks, shellQuote } = require("../src/clients");

const ENTRY = (folder) => ({ command: "npx", args: ["-y", "sentinel-ir-mcp@0.5", folder] });

function sandbox() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-setup-")));
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "a.js"), "module.exports = 1;\n");
    return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function setup(sb, argv, extra = {}) {
    let stdout = "";
    let stderr = "";
    const io = {
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
        env: { HOME: sb.home, ...(extra.env || {}) },
        platform: extra.platform || "linux",
        cwd: extra.cwd || sb.project,
        isTTY: Boolean(extra.answer !== undefined),
        questions: [],
        prompt: extra.answer !== undefined
            ? async (q) => (q.startsWith("Files or folders") ? (extra.excludeAnswer ?? "") : q.startsWith("Keep a log") ? (extra.auditAnswer ?? "") : extra.answer)
            : null,
        now: () => Date.UTC(2026, 9, 18, 12, 0, 0)
    };
    const code = await runCommand("setup", argv, io);
    return { code, stdout, stderr };
}

const windsurfFile = (sb) => path.join(sb.home, ".config", "devin", "mcp_config.json");
const listing = (dir) => fs.readdirSync(dir).sort();

test("clean install writes only the sentinel-ir entry with @0.4 and the project path", async () => {
    const sb = sandbox();
    try {
        const r = await setup(sb, ["--client", "windsurf", "--yes"]);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(windsurfFile(sb), "utf8")), { mcpServers: { "sentinel-ir": ENTRY(sb.project) } });
        assert.deepEqual(listing(path.dirname(windsurfFile(sb))), ["mcp_config.json"], "no backup or temp file for a new file");
        assert.match(r.stdout, /new file/);
    } finally { sb.cleanup(); }
});

test("existing servers and other fields are kept; a backup is made first; second run changes nothing", async () => {
    const sb = sandbox();
    try {
        const file = windsurfFile(sb);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const before = {
            theme: "dark",
            mcpServers: {
                github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { TOKEN: "x" } },
                postgres: { command: "docker", args: ["run", "pg"], disabled: true }
            },
            nested: { a: [1, 2, { b: null }] }
        };
        const original = JSON.stringify(before, null, 4) + "\n";
        fs.writeFileSync(file, original);

        const r = await setup(sb, ["--client", "windsurf", "--yes"]);
        assert.equal(r.code, 0, r.stderr);
        const after = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.deepEqual(after, { ...before, mcpServers: { ...before.mcpServers, "sentinel-ir": ENTRY(sb.project) } });
        assert.deepEqual(Object.keys(after.mcpServers), ["github", "postgres", "sentinel-ir"]);
        assert.match(fs.readFileSync(file, "utf8"), /^ {4}"theme"/m, "keeps the file's 4-space indent");
        assert.match(r.stdout, /Kept unchanged: github, postgres/);
        const backup = `${file}.bak-20261018T120000Z`;
        assert.equal(fs.readFileSync(backup, "utf8"), original, "backup is the untouched original");
        assert.ok(r.stdout.includes(backup));

        const written = fs.readFileSync(file, "utf8");
        const again = await setup(sb, ["--client", "windsurf", "--yes"]);
        assert.equal(again.code, 0);
        assert.match(again.stdout, /Already set up/);
        assert.equal(fs.readFileSync(file, "utf8"), written, "idempotent: bytes unchanged");
        assert.deepEqual(listing(path.dirname(file)), ["mcp_config.json", "mcp_config.json.bak-20261018T120000Z"], "no second backup, no duplicate");
    } finally { sb.cleanup(); }
});

test("a different existing sentinel-ir entry is replaced, shown before/after, never duplicated", async () => {
    const sb = sandbox();
    try {
        const file = windsurfFile(sb);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ mcpServers: { "sentinel-ir": { command: "npx", args: ["-y", "sentinel-ir-mcp", "/old"] } } }));
        const r = await setup(sb, ["--client", "windsurf", "--yes"]);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /before: .*\/old/);
        const after = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.deepEqual(after.mcpServers, { "sentinel-ir": ENTRY(sb.project) });
    } finally { sb.cleanup(); }
});

test("invalid JSON or a wrong shape is never overwritten", async () => {
    const sb = sandbox();
    try {
        const file = windsurfFile(sb);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        for (const bad of ['{ "mcpServers": { "a": 1, } ', "[1, 2]", '{"mcpServers": []}', '{"mcpServers": "x"}']) {
            fs.writeFileSync(file, bad);
            const r = await setup(sb, ["--client", "windsurf", "--yes"]);
            assert.equal(r.code, 1, bad);
            assert.match(r.stderr, /Nothing was changed/);
            assert.equal(fs.readFileSync(file, "utf8"), bad);
            assert.deepEqual(listing(path.dirname(file)), ["mcp_config.json"], "no backup or temp file");
        }
    } finally { sb.cleanup(); }
});

test("--dry-run and a missing --yes write nothing; an interactive 'y' writes, anything else cancels", async () => {
    const sb = sandbox();
    try {
        const file = windsurfFile(sb);
        const dry = await setup(sb, ["--client", "windsurf", "--dry-run"]);
        assert.equal(dry.code, 0);
        assert.match(dry.stdout, /Dry run\. Nothing was written/);
        assert.match(dry.stdout, /sentinel-ir-mcp@0\.5/);
        assert.equal(fs.existsSync(path.join(sb.home, ".config")), false);

        const noYes = await setup(sb, ["--client", "windsurf"]);
        assert.equal(noYes.code, 1);
        assert.match(noYes.stdout, /--yes/);
        assert.equal(fs.existsSync(file), false);

        const no = await setup(sb, ["--client", "windsurf"], { answer: "n" });
        assert.equal(no.code, 1);
        assert.equal(fs.existsSync(file), false);

        const yes = await setup(sb, ["--client", "windsurf"], { answer: "y" });
        assert.equal(yes.code, 0);
        assert.ok(fs.existsSync(file));
    } finally { sb.cleanup(); }
});

test("interactive client choice by number", async () => {
    const sb = sandbox();
    try {
        const r = await setup(sb, ["--dry-run"], { answer: "2" });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /Client: {2}Windsurf/);
        const none = await setup(sb, ["--dry-run"]);
        assert.equal(none.code, 1);
        assert.match(none.stderr, /--client/);
    } finally { sb.cleanup(); }
});

test("refuses the home folder, a disk root and missing folders", async () => {
    const sb = sandbox();
    try {
        for (const [project, msg] of [[sb.home, /home folder/], [path.parse(sb.base).root, /whole disk/], [path.join(sb.base, "nope"), /not found/]]) {
            const r = await setup(sb, ["--client", "windsurf", "--yes", "--project", project]);
            assert.equal(r.code, 1, project);
            assert.match(r.stderr, msg);
        }
        const fromHome = await setup(sb, ["--client", "windsurf", "--yes"], { cwd: sb.home });
        assert.equal(fromHome.code, 1, "running setup inside the home folder without --project is refused");
        assert.equal(fs.existsSync(windsurfFile(sb)), false);
    } finally { sb.cleanup(); }
});

test("Cursor: project config uses ${workspaceFolder}; --global uses ~/.cursor with the absolute path", async () => {
    const sb = sandbox();
    try {
        assert.equal((await setup(sb, ["--client", "cursor", "--yes"])).code, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.project, ".cursor", "mcp.json"), "utf8")),
            { mcpServers: { "sentinel-ir": ENTRY("${workspaceFolder}") } });
        assert.equal((await setup(sb, ["--client", "cursor", "--global", "--yes"])).code, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.home, ".cursor", "mcp.json"), "utf8")),
            { mcpServers: { "sentinel-ir": ENTRY(sb.project) } });
        const r = await setup(sb, ["--client", "windsurf", "--global", "--yes"]);
        assert.equal(r.code, 1);
        assert.match(r.stderr, /--global only applies/);
    } finally { sb.cleanup(); }
});

test("Claude Desktop: macOS and Windows locations (simulated HOME/APPDATA); Linux needs --config", async () => {
    const sb = sandbox();
    try {
        assert.equal((await setup(sb, ["--client", "claude-desktop", "--yes"], { platform: "darwin" })).code, 0);
        assert.ok(fs.existsSync(path.join(sb.home, "Library", "Application Support", "Claude", "claude_desktop_config.json")));

        const appdata = path.join(sb.base, "AppData", "Roaming");
        assert.equal((await setup(sb, ["--client", "claude-desktop", "--yes"], { platform: "win32", env: { APPDATA: appdata } })).code, 0);
        assert.ok(fs.existsSync(path.join(appdata, "Claude", "claude_desktop_config.json")));

        const linux = await setup(sb, ["--client", "claude-desktop", "--yes"]);
        assert.equal(linux.code, 1);
        assert.match(linux.stderr, /--config/);

        const custom = path.join(sb.base, "custom", "claude.json");
        assert.equal((await setup(sb, ["--client", "claude-desktop", "--yes", "--config", custom])).code, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(custom, "utf8")).mcpServers["sentinel-ir"], ENTRY(sb.project));
    } finally { sb.cleanup(); }
});

test("a symlinked config file is updated in place; the link stays a link", async () => {
    const sb = sandbox();
    try {
        const real = path.join(sb.base, "dotfiles", "mcp_config.json");
        fs.mkdirSync(path.dirname(real), { recursive: true });
        fs.writeFileSync(real, '{"mcpServers":{"other":{"command":"x"}}}');
        fs.mkdirSync(path.dirname(windsurfFile(sb)), { recursive: true });
        fs.symlinkSync(real, windsurfFile(sb));
        assert.equal((await setup(sb, ["--client", "windsurf", "--yes"])).code, 0);
        assert.ok(fs.lstatSync(windsurfFile(sb)).isSymbolicLink());
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(real, "utf8")).mcpServers), ["other", "sentinel-ir"]);
    } finally { sb.cleanup(); }
});

test("VS Code and Claude Code: setup prints their official command and writes nothing", async () => {
    const sb = sandbox();
    try {
        const vs = await setup(sb, ["--client", "vscode"]);
        assert.equal(vs.code, 0);
        const json = vs.stdout.match(/code --add-mcp '(.+)'/)[1];
        assert.deepEqual(JSON.parse(json), { name: "sentinel-ir", type: "stdio", ...ENTRY(sb.project) });
        const cc = await setup(sb, ["--client", "claude-code"]);
        assert.equal(cc.code, 0);
        assert.ok(cc.stdout.includes(`claude mcp add --transport stdio sentinel-ir -- npx -y sentinel-ir-mcp@0.5 ${shellQuote(sb.project)}`));
        assert.deepEqual(listing(sb.home), []);
        assert.deepEqual(listing(sb.project), ["a.js"]);
    } finally { sb.cleanup(); }
});

test("one-click links decode to the same pinned entry", () => {
    const { cursor, vscode } = installLinks();
    const cfg = new URL(cursor).searchParams.get("config");
    assert.deepEqual(JSON.parse(Buffer.from(cfg, "base64").toString()), ENTRY("${workspaceFolder}"));
    assert.deepEqual(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length))),
        { name: "sentinel-ir", type: "stdio", ...ENTRY("${workspaceFolder}") });
});

test("Windsurf: Devin config location, XDG_CONFIG_HOME and Windows %APPDATA% (simulated)", async () => {
    const sb = sandbox();
    try {
        const xdg = path.join(sb.base, "xdg");
        assert.equal((await setup(sb, ["--client", "windsurf", "--yes"], { env: { XDG_CONFIG_HOME: xdg } })).code, 0);
        assert.ok(fs.existsSync(path.join(xdg, "devin", "mcp_config.json")));

        const appdata = path.join(sb.base, "AppData", "Roaming");
        assert.equal((await setup(sb, ["--client", "windsurf", "--yes"], { platform: "win32", env: { APPDATA: appdata } })).code, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(appdata, "devin", "mcp_config.json"), "utf8")).mcpServers["sentinel-ir"],
            { command: "cmd", args: ["/c", "npx", "-y", "sentinel-ir-mcp@0.5", sb.project] });
    } finally { sb.cleanup(); }
});

test("Windsurf: servers in the old ~/.codeium file are copied to the new file; the old file is not touched", async () => {
    const sb = sandbox();
    try {
        const legacy = path.join(sb.home, ".codeium", "windsurf", "mcp_config.json");
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        const legacyText = '{\n    "mcpServers": { "github": { "command": "gh" } },\n    "x": 1\n}\n';
        fs.writeFileSync(legacy, legacyText);
        const r = await setup(sb, ["--client", "windsurf", "--yes"]);
        assert.equal(r.code, 0);
        assert.match(r.stdout, /Copied from: .*\.codeium/);
        assert.deepEqual(JSON.parse(fs.readFileSync(windsurfFile(sb), "utf8")),
            { mcpServers: { github: { command: "gh" }, "sentinel-ir": ENTRY(sb.project) }, x: 1 });
        assert.equal(fs.readFileSync(legacy, "utf8"), legacyText);
        assert.deepEqual(listing(path.dirname(legacy)), ["mcp_config.json"]);
        assert.match((await setup(sb, ["--client", "windsurf", "--yes"])).stdout, /Already set up/);
    } finally { sb.cleanup(); }
});

test("Windows (simulated): file entries use cmd /c npx; printed Claude Code command is for PowerShell", async () => {
    const sb = sandbox();
    try {
        const appdata = path.join(sb.base, "AppData", "Roaming");
        const win = { platform: "win32", env: { APPDATA: appdata } };
        assert.equal((await setup(sb, ["--client", "claude-desktop", "--yes"], win)).code, 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(appdata, "Claude", "claude_desktop_config.json"), "utf8")).mcpServers["sentinel-ir"],
            { command: "cmd", args: ["/c", "npx", "-y", "sentinel-ir-mcp@0.5", sb.project] });
        const cc = await setup(sb, ["--client", "claude-code"], win);
        assert.equal(cc.code, 0);
        assert.match(cc.stdout, /in PowerShell:[\s\S]*in Command Prompt/);
        assert.ok(cc.stdout.includes(`claude mcp add --transport stdio sentinel-ir '--' cmd /c npx -y sentinel-ir-mcp@0.5 '${sb.project}'`), cc.stdout);
        assert.ok(cc.stdout.includes(`claude mcp add --transport stdio sentinel-ir -- cmd /c npx -y sentinel-ir-mcp@0.5 "${sb.project}"`), cc.stdout);
        const vs = await setup(sb, ["--client", "vscode"], win);
        assert.ok(vs.stdout.includes("code --% --add-mcp \"{\\\"name\\\":"), vs.stdout);
        assert.ok(vs.stdout.includes("code --add-mcp \"{\\\"name\\\":"), vs.stdout);
        const amp = path.join(sb.base, "a & b");
        fs.mkdirSync(amp);
        const vsAmp = await setup(sb, ["--client", "vscode", "--project", amp], win);
        assert.equal(vsAmp.code, 0);
        const lines = vsAmp.stdout.split("\n").filter((l) => l.includes("--add-mcp"));
        assert.equal(lines.length, 2);
        for (const line of lines) {
            assert.ok(!line.includes("&") && line.includes("\\u0026"), line);
            const arg = line.slice(line.indexOf("--add-mcp ") + 10).trim();
            const config = JSON.parse(windowsArgUnquote(arg));
            assert.equal(config.args[2], amp);
        }
        const pct = path.join(sb.base, "a %OS% b");
        fs.mkdirSync(pct);
        const ccPct = await setup(sb, ["--client", "claude-code", "--project", pct], win);
        const ccLines = ccPct.stdout.split("\n").filter((l) => l.includes("claude mcp"));
        assert.equal(ccLines.length, 2);
        assert.ok(ccLines[0].includes(`claude mcp add --transport stdio sentinel-ir '--' cmd /c npx -y sentinel-ir-mcp@0.5 '${pct}'`), ccLines[0]);
        assert.match(ccLines[1], /claude mcp add-json sentinel-ir "/);
        assert.ok(!ccLines[1].includes("%OS%"), ccLines[1]);
        const config = JSON.parse(windowsArgUnquote(ccLines[1].slice(ccLines[1].indexOf(" sentinel-ir ") + 13).trim()));
        assert.deepEqual(config, { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "sentinel-ir-mcp@0.5", pct] });
        assert.match(ccPct.stdout, /contains %\. npm 10\.8 .*URI malformed/);
        const filePct = await setup(sb, ["--client", "cursor", "--project", pct, "--dry-run"], win);
        assert.match(filePct.stdout, /URI malformed/);
        const plain = await setup(sb, ["--client", "claude-code", "--project", sb.project], win);
        assert.ok(!plain.stdout.includes("URI malformed"), plain.stdout);
    } finally { sb.cleanup(); }
});

// Inverse of the Windows command-line quoting of one "..." argument (CommandLineToArgvW).
function windowsArgUnquote(s) {
    assert.ok(s.startsWith('"') && s.endsWith('"'), s);
    let out = "";
    let i = 1;
    const end = s.length - 1;
    while (i < end) {
        let n = 0;
        while (i < end && s[i] === "\\") { n++; i++; }
        if (i === end) out += "\\".repeat(n / 2);
        else if (s[i] === '"') { out += "\\".repeat(Math.floor(n / 2)) + '"'; i++; }
        else { out += "\\".repeat(n) + s[i]; i++; }
    }
    return out;
}

test("printed doctor hints quote the folder so they can be pasted into a shell", async () => {
    const sb = sandbox();
    try {
        const odd = path.join(sb.base, "it's $HOME & 100% (x)");
        fs.mkdirSync(odd);
        const cc = await setup(sb, ["--client", "claude-code", "--project", odd]);
        assert.ok(cc.stdout.includes(`doctor --client claude-code --project ${shellQuote(odd)}\n`), cc.stdout);
        const cur = await setup(sb, ["--client", "cursor", "--project", odd, "--yes"]);
        assert.ok(cur.stdout.includes(`doctor --client cursor --project ${shellQuote(odd)}\n`), cur.stdout);
        const win = await setup(sb, ["--client", "claude-code", "--project", odd], { platform: "win32", env: { APPDATA: path.join(sb.home, "AppData") } });
        assert.ok(win.stdout.includes(`(PowerShell): npx -y sentinel-ir-mcp@0.5 doctor --client claude-code --project '${odd.replace(/'/g, "''")}'\n`), win.stdout);
        if (process.platform !== "win32") {
            const line = cc.stdout.split("\n").find((l) => l.includes("doctor --client"));
            const argv = require("child_process").execFileSync("bash", ["-c", `printf '%s\\n' ${line.slice(line.indexOf("--project"))}`], { encoding: "utf8" });
            assert.equal(argv, `--project\n${odd}\n`);
        }
    } finally { sb.cleanup(); }
});
