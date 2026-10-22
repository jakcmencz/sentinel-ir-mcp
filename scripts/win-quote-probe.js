"use strict";

// Windows-only measurement: which quoting of the printed install commands
// reaches a .cmd shim (like code.cmd / claude.cmd) with the exact arguments,
// when the command setup prints is pasted into PowerShell 5.1, PowerShell 7 or cmd.exe.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "quote-probe-")));
const project = path.join(dir, "my project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(dir, "argv.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
for (const name of ["code", "claude"]) fs.writeFileSync(path.join(dir, `${name}.cmd`), `@node "%~dp0argv.js" %*\r\n`);
const env = { ...process.env, Path: `${dir};${process.env.Path || process.env.PATH}` };

const { installCommand } = require("../src/clients");
// Windows names cannot contain < > | " so these cover the remaining cmd.exe/PowerShell specials.
const projects = [project, ...["it's $HOME & co", "100% ^caret! (x)", "a %OS% b", "x`y; @z"].map((n) => path.join(dir, n))];
for (const p of projects.slice(1)) fs.mkdirSync(p);
// VS Code parses the --add-mcp value as JSON, so compare the parsed value.
const matches = (tool, folder, argv) => tool === "vscode"
    ? Array.isArray(argv) && argv.length === 2 && argv[0] === "--add-mcp" && (() => {
        try {
            return JSON.stringify(JSON.parse(argv[1])) === JSON.stringify({ name: "sentinel-ir", type: "stdio", command: "npx", args: ["-y", "sentinel-ir-mcp@0.2", folder] });
        } catch { return false; }
    })()
    : Array.isArray(argv) && argv[1] === "add-json"
        ? argv.length === 4 && argv[0] === "mcp" && argv[2] === "sentinel-ir" && (() => {
            try {
                return JSON.stringify(JSON.parse(argv[3])) === JSON.stringify({ type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "sentinel-ir-mcp@0.2", folder] });
            } catch { return false; }
        })()
        : JSON.stringify(argv) === JSON.stringify(["mcp", "add", "--transport", "stdio", "sentinel-ir", "--", "cmd", "/c", "npx", "-y", "sentinel-ir-mcp@0.2", folder]);

const shells = [];
const has = (exe) => spawnSync("where", [exe], { encoding: "utf8" }).status === 0;
if (has("powershell.exe")) shells.push({ name: "powershell5", run: (f) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { env, encoding: "utf8" }), ext: ".ps1" });
if (has("pwsh.exe")) shells.push({ name: "pwsh7", run: (f) => spawnSync("pwsh.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { env, encoding: "utf8" }), ext: ".ps1" });
// A command line given to cmd /c is parsed like a line typed at the prompt
// (unlike a .cmd file, where a lone % is dropped).
shells.push({ name: "cmd", run: (line) => spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { env, encoding: "utf8", windowsVerbatimArguments: true }), line: true });

const results = [];
for (const shell of shells) {
    if (shell.name.startsWith("pwsh") || shell.name.startsWith("powershell")) {
        const v = shell.run(writeScript("$PSVersionTable.PSVersion.ToString()", shell.ext));
        console.log(`${shell.name}: version ${String(v.stdout).trim()}`);
    }
    const kind = shell.name === "cmd" ? "cmd" : "powershell";
    for (const folder of projects) {
        for (const [tool, client] of [["vscode", "vscode"], ["claude", "claude-code"]]) {
            const line = installCommand(client, folder, "win32", kind);
            const r = shell.run(shell.line ? line : writeScript(line, shell.ext));
            let got;
            try { got = JSON.parse(r.stdout); } catch { got = { stdout: r.stdout, stderr: r.stderr }; }
            const ok = matches(tool, folder, got);
            results.push({ shell: shell.name, tool, folder, line, ok, got: ok ? undefined : got });
            console.log(`${ok ? "OK  " : "BAD "} ${shell.name} ${tool} [${path.basename(folder)}]: ${line}${ok ? "" : ` -> ${JSON.stringify(got).slice(0, 300)}`}`);
        }
    }
}
fs.writeFileSync(path.join(__dirname, "..", `compat-quote-node${process.versions.node.split(".")[0]}.json`), JSON.stringify({ projects, results }, null, 2));
process.exitCode = results.every((r) => r.ok) ? 0 : 1;

function writeScript(body, ext) {
    const f = path.join(dir, `probe-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(f, ext === ".ps1" ? `\uFEFF${body}\r\n` : `${body}\r\n`);
    return f;
}
