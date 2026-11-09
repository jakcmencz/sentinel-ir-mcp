"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const {
    createAuditLog, defaultAuditDir, normalizeAuditDir, assertOutsideProjects, describeCall, dayName, MAX_DAY_BYTES, AuditLogError
} = require("../src/auditLog");
const { serverEntry, installCommand, entryAuditLog } = require("../src/clients");
const { entryFolders } = require("../src/doctor");
const { runCommand } = require("../src/cli");
const { safe } = require("../src/logView");
const { BIN, call } = require("./helpers");

const MARKER = "AUDIT_SOURCE_MARKER";
const ESC = "\u001b";

function sandbox() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-ir-audit-")));
    const project = path.join(base, "project");
    const home = path.join(base, "home");
    const logs = path.join(base, "logs");
    for (const [rel, text] of Object.entries({
        "app.js": `module.exports = "${MARKER}";\n`,
        "danger.js": `eval(process.argv[2]); // ${MARKER}\n`,
        "secrets/key.js": `module.exports = "${MARKER}";\n`,
        "big.js": `// ${"x".repeat(2048)}\n`
    })) {
        fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
        fs.writeFileSync(path.join(project, rel), text);
    }
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "x.js"), `module.exports = "${MARKER}";\n`);
    return {
        base, project, home, logs,
        file: path.join(home, ".config", "devin", "mcp_config.json"),
        cleanup: () => fs.rmSync(base, { recursive: true, force: true })
    };
}

async function connect(args, env = {}) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, ...args], stderr: "pipe", env: { ...process.env, ...env } });
    let stderr = "";
    transport.stderr.on("data", (d) => { stderr += d; });
    const client = new Client({ name: "audit-test-client", version: "1.0.0" });
    await client.connect(transport);
    return { client, stderr: () => stderr };
}

function readLines(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()
        .flatMap((n) => fs.readFileSync(path.join(dir, n), "utf8").split("\n").filter(Boolean));
}

async function waitForLines(dir, count) {
    for (let i = 0; i < 100; i++) {
        if (readLines(dir).length >= count) break;
        await new Promise((r) => setTimeout(r, 30));
    }
    return readLines(dir);
}

async function cli(sb, command, argv, { answers, platform = "linux", env = {} } = {}) {
    let stdout = "";
    let stderr = "";
    const questions = [];
    const queue = answers ? [...answers] : null;
    const io = {
        stdout: { write: (s) => { stdout += s; } },
        stderr: { write: (s) => { stderr += s; } },
        env: { HOME: sb.home, ...env }, platform, cwd: sb.project,
        isTTY: Boolean(queue), prompt: queue ? async (q) => { questions.push(q); return queue.shift() ?? ""; } : null
    };
    const code = await runCommand(command, argv, io);
    return { code, stdout, stderr, questions };
}
const argsOf = (sb) => JSON.parse(fs.readFileSync(sb.file, "utf8")).mcpServers["sentinel-ir"].args;

test("every tool call is logged with its outcome, never with source code", async () => {
    const sb = sandbox();
    const { client } = await connect([`--audit-log=${sb.logs}`, "--exclude=secrets", "--max-file-bytes=1024", sb.project]);
    try {
        assert.equal((await call(client, "analyze_code", { code: `const s = "${MARKER}"; eval(s);`, target: "x.ts" })).isError, undefined);
        assert.ok(!(await call(client, "analyze_file", { path: "danger.js" })).isError);
        assert.ok((await call(client, "analyze_file", { path: "secrets/key.js" })).isError);
        assert.ok((await call(client, "analyze_file", { path: "../home/x.js" })).isError);
        assert.ok((await call(client, "analyze_file", { path: "missing.js" })).isError);
        assert.ok((await call(client, "analyze_file", { path: "big.js" })).isError);
        assert.ok(!(await call(client, "analyze_directory", { path: "." })).isError);
    } finally {
        await client.close();
    }
    try {
        const lines = await waitForLines(sb.logs, 8);
        assert.equal(lines.length, 8);
        const all = lines.join("\n");
        assert.ok(!all.includes(MARKER), "source code must never reach the log");
        const [start, code, file, excluded, outside, missing, big, dir] = lines.map((l) => JSON.parse(l));
        assert.equal(start.event, "start");
        assert.deepEqual(start.folders, [sb.project]);
        assert.equal(start.exclusions, 1);
        assert.equal(code.tool, "analyze_code");
        assert.equal(code.client, "audit-test-client");
        assert.equal(code.bytes, Buffer.byteLength(`const s = "${MARKER}"; eval(s);`));
        assert.equal(code.language, "typescript");
        assert.equal(code.risk, "critical");
        assert.equal(typeof code.ms, "number");
        assert.equal(file.ok, true);
        assert.equal(file.risk, "critical");
        assert.equal(file.path, "danger.js");
        assert.deepEqual([excluded.reason, outside.reason, missing.reason, big.reason], ["excluded", "outside", "not-found", "too-large"]);
        assert.ok(lines.every((l) => !JSON.parse(l).message || !JSON.parse(l).message.includes(MARKER)));
        assert.equal(dir.tool, "analyze_directory");
        assert.equal(dir.excluded, 1);
        assert.deepEqual(dir.top, [{ path: "danger.js", risk: "critical" }]);
        assert.ok(!JSON.stringify(dir).includes("secrets"), "excluded names stay out of the log too");
        const view = await cli(sb, "log", ["--dir", sb.logs]);
        assert.equal(view.code, 0);
        assert.match(view.stdout, /\[audit-test-client\] REFUSED file secrets\/key\.js: excluded by your settings/);
        assert.match(view.stdout, /REFUSED file \.\.\/home\/x\.js: outside the project folder/);
        assert.match(view.stdout, /file danger\.js: critical/);
        assert.match(view.stdout, /pasted code \(\d+ bytes, typescript\): critical/);
        assert.match(view.stdout, /folder \.: 2 file\(s\) \(1 critical, 1 low\), 1 excluded, 1 not read \(too large or unreadable\)\n {4}critical danger\.js/);
        assert.match(view.stdout, /8 entries\. Log folder: /);
    } finally {
        sb.cleanup();
    }
});

test("no --audit-log: nothing is written anywhere", async () => {
    const sb = sandbox();
    const state = path.join(sb.base, "state");
    const { client } = await connect([sb.project], { HOME: sb.home, XDG_STATE_HOME: state, LOCALAPPDATA: state });
    try {
        await call(client, "analyze_file", { path: "app.js" });
    } finally {
        await client.close();
    }
    try {
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(!fs.existsSync(state));
        assert.deepEqual(fs.readdirSync(sb.home), ["x.js"]);
        assert.deepEqual(fs.readdirSync(sb.project).sort(), ["app.js", "big.js", "danger.js", "secrets"]);
    } finally {
        sb.cleanup();
    }
});

test("--audit-log alone uses the default folder for this system", async () => {
    const sb = sandbox();
    const state = path.join(sb.base, "state");
    const env = { HOME: sb.home, XDG_STATE_HOME: state, LOCALAPPDATA: state };
    const { client } = await connect(["--audit-log", sb.project], env);
    try {
        await call(client, "analyze_file", { path: "app.js" });
    } finally {
        await client.close();
    }
    try {
        const dir = defaultAuditDir(env, process.platform);
        assert.equal((await waitForLines(dir, 2)).length, 2);
        const view = await cli(sb, "log", [], { env, platform: process.platform });
        assert.match(view.stdout, /file app\.js: low/);
    } finally {
        sb.cleanup();
    }
});

test("default folders: Windows, macOS, Linux", () => {
    assert.equal(defaultAuditDir({ LOCALAPPDATA: "C:\\Users\\Jan\\AppData\\Local" }, "win32"),
        path.join("C:\\Users\\Jan\\AppData\\Local", "sentinel-ir-mcp", "audit-log"));
    assert.equal(defaultAuditDir({ HOME: "/Users/jan" }, "darwin"), path.join("/Users/jan", "Library", "Logs", "sentinel-ir-mcp"));
    assert.equal(defaultAuditDir({ HOME: "/home/jan" }, "linux"), path.join("/home/jan", ".local", "state", "sentinel-ir-mcp", "audit-log"));
    assert.equal(defaultAuditDir({ HOME: "/home/jan", XDG_STATE_HOME: "/s" }, "linux"), path.join("/s", "sentinel-ir-mcp", "audit-log"));
});

test("a path with newlines and terminal codes cannot fake a log line or recolor the terminal", async () => {
    const sb = sandbox();
    const evil = `x.js\n{"ts":"2026-01-01T00:00:00Z","tool":"analyze_file","ok":true,"path":"fake.js","risk":"low"}\r${ESC}[2J${ESC}]0;pwned\u0007\u202egnp.js\u2028y`;
    const { client } = await connect([`--audit-log=${sb.logs}`, sb.project]);
    try {
        await call(client, "analyze_file", { path: evil });
        await call(client, "analyze_directory", { path: evil });
        await call(client, "analyze_code", { code: "1", target: evil });
    } finally {
        await client.close();
    }
    try {
        const lines = await waitForLines(sb.logs, 4);
        assert.equal(lines.length, 4, "one line per call, whatever the path contains");
        assert.equal(JSON.parse(lines[1]).path, evil.slice(0, 300).replace(/[\ud800-\udbff]$/, "") + (evil.length > 300 ? "…" : ""));
        const view = await cli(sb, "log", ["--dir", sb.logs]);
        assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f\u202e\u2028]/.test(view.stdout), JSON.stringify(view.stdout));
        assert.equal(view.stdout.split("\n").filter((l) => /fake\.js/.test(l)).length, 2);
        assert.ok(view.stdout.split("\n").every((l) => !l.startsWith("{")));
        assert.match(view.stdout, /\\u\{1b\}\[2J/);
        assert.equal(safe(`a${ESC}b\u0085c\ufeffd`), "a\\u{1b}b\\u{85}c\\u{feff}d");
    } finally {
        sb.cleanup();
    }
});

test("two servers writing at once never mix or lose lines", async () => {
    const sb = sandbox();
    const servers = await Promise.all([0, 1, 2].map(() => connect([`--audit-log=${sb.logs}`, sb.project])));
    const PER = 60;
    try {
        await Promise.all(servers.flatMap(({ client }) => Array.from({ length: PER }, (_, i) =>
            call(client, i % 2 ? "analyze_file" : "analyze_code", i % 2 ? { path: `app.js` } : { code: `let a${i} = ${"1+".repeat(400)}1;` }))));
    } finally {
        await Promise.all(servers.map(({ client }) => client.close()));
    }
    try {
        const lines = await waitForLines(sb.logs, 3 * (PER + 1));
        assert.equal(lines.length, 3 * (PER + 1));
        const parsed = lines.map((l) => JSON.parse(l));
        assert.equal(new Set(parsed.map((e) => e.pid)).size, 3);
        assert.equal(parsed.filter((e) => e.tool === "analyze_code").length, 3 * PER / 2);
    } finally {
        sb.cleanup();
    }
});

test("an unwritable log never breaks the tools and is reported once", async () => {
    const sb = sandbox();
    const blocker = path.join(sb.base, "not-a-folder");
    fs.writeFileSync(blocker, "");
    const { client, stderr } = await connect([`--audit-log=${path.join(blocker, "logs")}`, sb.project]);
    try {
        for (let i = 0; i < 5; i++) assert.ok(!(await call(client, "analyze_file", { path: "app.js" })).isError);
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(stderr().match(/cannot write the audit log/g).length, 1, stderr());
    } finally {
        await client.close();
        sb.cleanup();
    }
});

test("a day's file stops at the size limit with one note; old days are removed", async () => {
    const sb = sandbox();
    try {
        fs.mkdirSync(sb.logs);
        const now = new Date(2026, 9, 18, 12).getTime();
        const day = (offset) => dayName(new Date(2026, 9, 18 - offset, 12));
        for (const n of [29, 30, 31, 45]) fs.writeFileSync(path.join(sb.logs, day(n)), "{}\n");
        const old = path.join(sb.logs, day(40));
        fs.mkdirSync(old);
        fs.writeFileSync(path.join(sb.logs, "notes.txt"), "mine");
        fs.writeFileSync(path.join(sb.logs, day(0)), "");
        fs.truncateSync(path.join(sb.logs, day(0)), MAX_DAY_BYTES - 1);
        fs.appendFileSync(path.join(sb.logs, day(0)), "\n");
        const log = createAuditLog({ dir: sb.logs, now: () => now, onError: (m) => assert.fail(m) });
        for (let i = 0; i < 5; i++) log.record({ tool: "analyze_code", ok: true });
        await log.flush();
        assert.deepEqual(fs.readdirSync(sb.logs).sort(), [day(30), day(29), day(0), day(40), "notes.txt"].sort(), "only old day files go, nothing else");
        const tail = fs.readFileSync(path.join(sb.logs, day(0))).subarray(MAX_DAY_BYTES).toString();
        assert.equal(tail.split("\n").filter(Boolean).length, 1);
        assert.equal(JSON.parse(tail).event, "full");
        const view = await cli(sb, "log", ["--dir", sb.logs, "--all"]);
        assert.match(view.stdout, /reached its size limit/);
        assert.match(view.stdout, /3 damaged line\(s\) skipped/, "the two {} lines and the zero bytes");
    } finally {
        sb.cleanup();
    }
});

test("a day file with a second name (hard link) is not written, on every system", async () => {
    const sb = sandbox();
    try {
        fs.mkdirSync(sb.logs);
        const victim = path.join(sb.base, "victim.txt");
        fs.writeFileSync(victim, "keep\n");
        fs.linkSync(victim, path.join(sb.logs, dayName(new Date())));
        const errors = [];
        const log = createAuditLog({ dir: sb.logs, onError: (m) => errors.push(m) });
        log.record({ tool: "analyze_file", path: "a.js", ok: true });
        log.record({ tool: "analyze_file", path: "b.js", ok: true });
        await log.flush();
        assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
        assert.equal(errors.length, 1, "reported once");
        assert.match(errors[0], /hard link/);
    } finally {
        sb.cleanup();
    }
});

test("a day stops below 50 MB even when the next line would cross it", async () => {
    const sb = sandbox();
    try {
        fs.mkdirSync(sb.logs);
        const file = path.join(sb.logs, dayName(new Date()));
        fs.writeFileSync(file, "");
        fs.truncateSync(file, MAX_DAY_BYTES - 1024 * 1024 - 10);
        const log = createAuditLog({ dir: sb.logs, onError: (m) => assert.fail(m) });
        log.record({ tool: "analyze_file", path: "x".repeat(200), ok: true });
        log.record({ tool: "analyze_file", path: "y", ok: true });
        await log.flush();
        const tail = fs.readFileSync(file).subarray(MAX_DAY_BYTES - 1024 * 1024 - 10).toString();
        assert.deepEqual(tail.split("\n").filter(Boolean).map((l) => JSON.parse(l).event), ["full"]);
        assert.ok(fs.statSync(file).size < MAX_DAY_BYTES);
    } finally {
        sb.cleanup();
    }
});

test("the log file is never written through a symlink", async (t) => {
    const sb = sandbox();
    try {
        fs.mkdirSync(sb.logs);
        const victim = path.join(sb.base, "victim.txt");
        fs.writeFileSync(victim, "keep");
        const link = path.join(sb.logs, dayName(new Date()));
        try { fs.symlinkSync(victim, link, "file"); } catch (e) {
            if (e.code === "EPERM") return t.skip("this Windows account may not create symlinks");
            throw e;
        }
        const errors = [];
        const log = createAuditLog({ dir: sb.logs, onError: (m) => errors.push(m) });
        log.record({ tool: "analyze_code", ok: true });
        await log.flush();
        assert.equal(fs.readFileSync(victim, "utf8"), "keep");
        assert.equal(errors.length, 1);

        const missing = path.join(sb.base, "would-be-created.txt");
        fs.rmSync(link);
        fs.symlinkSync(missing, link, "file");
        log.record({ tool: "analyze_code", ok: true });
        await log.flush();
        assert.equal(fs.existsSync(missing), false, "a dangling symlink does not create its target");
    } finally {
        sb.cleanup();
    }
});

test("the server refuses a bad --audit-log before it starts", () => {
    const sb = sandbox();
    try {
        const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
        assert.match(run("--audit-log=logs", sb.project).stderr, /must be a full path/);
        assert.match(run("--audit-log=", sb.project).stderr, /needs a folder/);
        assert.match(run(`--audit-log=${path.join(sb.base, "a&b")}`, sb.project).stderr, /not allowed/);
        assert.match(run(`--audit-log=${path.join(sb.project, "logs")}`, sb.project).stderr, /inside the project folder/);
        if (process.platform !== "linux") assert.match(run(`--audit-log=${path.join(sb.project.toUpperCase(), "logs")}`, sb.project).stderr, /inside the project folder/);
        assert.ok(!fs.existsSync(path.join(sb.project, "logs")));
    } finally {
        sb.cleanup();
    }
});

test("assertOutsideProjects follows symlinks and ignores case where the system does", () => {
    const sb = sandbox();
    try {
        assert.throws(() => assertOutsideProjects("/P/x", ["/p"], true), AuditLogError);
        // Windows paths never differ by case only (path.win32.relative ignores case).
        if (process.platform !== "win32") assert.doesNotThrow(() => assertOutsideProjects("/P/x", ["/p"], false));
        assert.doesNotThrow(() => assertOutsideProjects(sb.logs, [sb.project], false));
        if (process.platform !== "win32") {
            fs.symlinkSync(sb.project, path.join(sb.base, "alias"));
            assert.throws(() => assertOutsideProjects(path.join(sb.base, "alias", "new", "logs"), [sb.project], false), /inside the project/);
        }
        assert.throws(() => normalizeAuditDir("C:logs"), /full path|not allowed/);
    } finally {
        sb.cleanup();
    }
});

test("setup: --audit-log turns it on, rerunning keeps it, --no-audit-log turns it off", async () => {
    const sb = sandbox();
    try {
        const on = await cli(sb, "setup", ["--client", "windsurf", "--audit-log", "--yes"]);
        assert.equal(on.code, 0, on.stderr);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.4", "--audit-log", sb.project]);
        assert.match(on.stdout, /Audit log: on, in .*\.local[\\/]state[\\/]sentinel-ir-mcp[\\/]audit-log/);
        assert.match(on.stdout, /see it: npx -y sentinel-ir-mcp@0\.4 log\n/);
        const keep = await cli(sb, "setup", ["--client", "windsurf", "--yes"]);
        assert.match(keep.stdout, /Already set up/);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.4", "--audit-log", sb.project]);
        const moved = await cli(sb, "setup", ["--client", "windsurf", `--audit-log=${sb.logs}`, "--exclude", "secrets", "--yes"]);
        assert.equal(moved.code, 0, moved.stderr);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.4", "--exclude=secrets", `--audit-log=${sb.logs}`, sb.project]);
        assert.match(moved.stdout, new RegExp(`log --dir ${sb.logs.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
        assert.deepEqual(entryFolders(argsOf(sb)), [sb.project]);
        const off = await cli(sb, "setup", ["--client", "windsurf", "--no-audit-log", "--yes"]);
        assert.equal(off.code, 0);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.4", "--exclude=secrets", sb.project]);
        assert.match(off.stdout, /Audit log: off/);
        const both = await cli(sb, "setup", ["--client", "windsurf", "--audit-log", "--no-audit-log", "--yes"]);
        assert.equal(both.code, 1);
        assert.match(both.stderr, /either --audit-log or --no-audit-log/);
        const inside = await cli(sb, "setup", ["--client", "windsurf", `--audit-log=${path.join(sb.project, "logs")}`, "--yes"]);
        assert.equal(inside.code, 1);
        assert.match(inside.stderr, /inside the project folder/);
        const relative = await cli(sb, "setup", ["--client", "windsurf", "--audit-log=logs", "--yes"]);
        assert.match(relative.stderr, /must be a full path/);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.4", "--exclude=secrets", sb.project], "a refused change writes nothing");
    } finally {
        sb.cleanup();
    }
});

test("setup asks one plain question; Enter keeps the current answer", async () => {
    const sb = sandbox();
    try {
        const first = await cli(sb, "setup", ["--client", "windsurf"], { answers: ["", "y", "y"] });
        assert.equal(first.code, 0, first.stderr);
        assert.match(first.questions[1], /Keep a log of what the agent asks for \(file names and results, never your code\)\? \[y\/N\]/);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.4", "--audit-log", sb.project]);
        const keep = await cli(sb, "setup", ["--client", "windsurf"], { answers: ["", ""] });
        assert.match(keep.questions[1], /now: on; Enter = keep, n = off/);
        assert.match(keep.stdout, /Already set up/);
        const bad = await cli(sb, "setup", ["--client", "windsurf"], { answers: ["", "maybe"] });
        assert.equal(bad.code, 1);
        assert.match(bad.stderr, /Answer y or n/);
        const off = await cli(sb, "setup", ["--client", "windsurf"], { answers: ["", "N", "y"] });
        assert.equal(off.code, 0);
        assert.deepEqual(argsOf(sb), ["-y", "sentinel-ir-mcp@0.4", sb.project]);
        const fresh = sandbox();
        try {
            const enter = await cli(fresh, "setup", ["--client", "windsurf"], { answers: ["", "", "y"] });
            assert.equal(enter.code, 0);
            assert.deepEqual(argsOf(fresh), ["-y", "sentinel-ir-mcp@0.4", fresh.project], "Enter on a new setup means no log");
        } finally {
            fresh.cleanup();
        }
    } finally {
        sb.cleanup();
    }
});

test("Windows: the entry runs through cmd /c with the log flag, commands carry it safely", () => {
    const dir = "C:\\Users\\Jan Novák\\Logs";
    assert.deepEqual(serverEntry("C:\\proj", "win32", [], { dir }),
        { command: "cmd", args: ["/c", "npx", "-y", "sentinel-ir-mcp@0.4", `--audit-log=${dir}`, "C:\\proj"] });
    assert.deepEqual(entryAuditLog(serverEntry("C:\\proj", "win32", [], { dir }).args), { dir });
    assert.deepEqual(entryAuditLog(["--audit-log=a", "--audit-log"]), { dir: null }, "the last flag wins, like the server");
    const ps = installCommand("claude-code", "C:\\proj", "win32", "powershell", ["secrets"], { dir });
    assert.match(ps, /'--audit-log=C:\\Users\\Jan Novák\\Logs'/);
    const cmd = installCommand("claude-code", "C:\\proj", "win32", "cmd", [], { dir });
    assert.ok(cmd.includes(`"--audit-log=${dir}"`), cmd);
    const vs = installCommand("vscode", "C:\\proj", "win32", "cmd", [], { dir: null });
    assert.match(vs, /--audit-log/);
    assert.throws(() => normalizeAuditDir("C:\\a%PATH%b"), /not allowed/);
    assert.throws(() => normalizeAuditDir("C:\\a\"b"), /not allowed/);
});

test("Windows setup writes the default %LOCALAPPDATA% folder hint", async () => {
    const sb = sandbox();
    try {
        const r = await cli(sb, "setup", ["--client", "windsurf", "--audit-log", "--yes"], {
            platform: "win32", env: { APPDATA: path.join(sb.home, "AppData", "Roaming"), LOCALAPPDATA: path.join(sb.home, "AppData", "Local") }
        });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /Audit log: on, in .*AppData.Local.sentinel-ir-mcp.audit-log/);
    } finally {
        sb.cleanup();
    }
});

test("doctor shows the log state and proves the server can write it", async () => {
    const sb = sandbox();
    try {
        await cli(sb, "setup", ["--client", "windsurf", `--audit-log=${sb.logs}`, "--yes"]);
        const r = await cli(sb, "doctor", ["--client", "windsurf"]);
        assert.equal(r.code, 0, r.stdout);
        assert.match(r.stdout, /\[ok\] {3}Audit log: on, in .*logs \(empty so far\); see it: npx -y sentinel-ir-mcp@0\.4 log --dir "/);
        assert.match(r.stdout, /\[ok\] {3}Audit log: can be written \(doctor added one "check" line to /);
        const view = await cli(sb, "log", ["--dir", sb.logs]);
        assert.match(view.stdout, /doctor checked that the log can be written\n\n1 entries\./, "one line, none of the doctor's tool calls");
        const again = await cli(sb, "doctor", ["--client", "windsurf"]);
        assert.match(again.stdout, /Audit log: on, in .*\(1 day\(s\), \d+\.\d kB|Audit log: on, in .*\(1 day\(s\), \d+ B/);

        fs.rmSync(sb.logs, { recursive: true });
        fs.writeFileSync(sb.logs, "");
        const broken = await cli(sb, "doctor", ["--client", "windsurf"]);
        assert.equal(broken.code, 1);
        assert.match(broken.stdout, /\[FAIL\] Audit log: nothing could be written/);
        assert.match(broken.stdout, /\[ok\] {3}MCP handshake/, "the tools still work");

        const cfg = JSON.parse(fs.readFileSync(sb.file, "utf8"));
        cfg.mcpServers["sentinel-ir"].args.splice(2, 1, "--audit-log=relative/logs");
        fs.writeFileSync(sb.file, JSON.stringify(cfg));
        const bad = await cli(sb, "doctor", ["--client", "windsurf"]);
        assert.equal(bad.code, 1);
        assert.match(bad.stdout, /\[FAIL\] Windsurf: audit log folder "relative\/logs" must be a full path, e\.g\. .*; the server will not start/);
        assert.doesNotMatch(bad.stdout, /Audit log: off/, "a broken setting is not reported as off");

        await cli(sb, "setup", ["--client", "windsurf", "--no-audit-log", "--yes"]);
        const off = await cli(sb, "doctor", ["--client", "windsurf"]);
        assert.match(off.stdout, /Audit log: off \(turn it on: npx -y sentinel-ir-mcp@0\.4 setup --audit-log\)/);
    } finally {
        sb.cleanup();
    }
});

test("log: empty, last 50, --all, --json, damaged lines, bad options", async () => {
    const sb = sandbox();
    try {
        const empty = await cli(sb, "log", ["--dir", sb.logs]);
        assert.equal(empty.code, 0);
        assert.match(empty.stdout, /No audit log in .*\nTurn it on with: npx -y sentinel-ir-mcp@0\.4 setup --audit-log/);
        fs.mkdirSync(sb.logs);
        const rows = Array.from({ length: 70 }, (_, i) => JSON.stringify({ ts: new Date(2026, 9, 17, 10, 0, i).toISOString(), tool: "analyze_file", ok: true, path: `f${i}.js`, risk: "low", analysisStatus: "complete" }));
        rows.splice(10, 0, "{broken", "[1,2]", "null");
        fs.writeFileSync(path.join(sb.logs, dayName(new Date(2026, 9, 17))), rows.join("\n") + "\n");
        const recent = await cli(sb, "log", ["--dir", sb.logs]);
        assert.match(recent.stdout, /^2026-10-17 10:00:20 file f20\.js: low/);
        assert.match(recent.stdout, /Showing the last 50 entries; --all shows everything\./);
        assert.match(recent.stdout, /3 damaged line\(s\) skipped/);
        const all = await cli(sb, "log", ["--dir", sb.logs, "--all"]);
        assert.equal(all.stdout.split("\n").filter((l) => /file f\d+\.js/.test(l)).length, 70);
        const json = JSON.parse((await cli(sb, "log", ["--dir", sb.logs, "--json"])).stdout);
        assert.equal(json.entries.length, 50);
        assert.equal(json.damaged, 3);
        const jsonAll = JSON.parse((await cli(sb, "log", ["--dir", sb.logs, "--json", "--all"])).stdout);
        assert.equal(jsonAll.entries.length, 70);
        fs.writeFileSync(path.join(sb.logs, dayName(new Date(2026, 9, 18))), rows.slice(0, 5).join("\n") + "\n");
        const twoDays = await cli(sb, "log", ["--dir", sb.logs]);
        assert.match(twoDays.stdout, /Showing the last 50 entries/);
        assert.equal(twoDays.stdout.split("\n").filter((l) => /file f\d+\.js/.test(l)).length, 50);
        assert.equal(JSON.parse((await cli(sb, "log", ["--dir", path.join(sb.base, "none"), "--json"])).stdout).entries.length, 0);
        assert.equal((await cli(sb, "log", ["--dir"])).code, 2);
        assert.equal((await cli(sb, "log", ["--dir", "a&b"])).code, 2);
        assert.equal((await cli(sb, "log", ["--follow"])).code, 2);
        assert.match((await cli(sb, "log", ["--help"])).stdout, /Shows what the agent asked this server for/);
    } finally {
        sb.cleanup();
    }
});

test("describeCall keeps long values short and counts code in bytes", () => {
    const e = describeCall("analyze_file", { path: "😀".repeat(400) }, { error: "x".repeat(5000), reason: "error" });
    assert.ok(e.path.length <= 301);
    assert.ok(e.message.length <= 301);
    assert.doesNotThrow(() => Buffer.from(e.path, "utf8").toString("utf8"));
    assert.ok(!/[\ud800-\udbff]…$/.test(e.path), "no half emoji at the cut");
    assert.equal(describeCall("analyze_code", { code: "č" }, { result: { world: { risk: "low" }, analysisStatus: "complete", language: "javascript" } }).bytes, 2);
});
