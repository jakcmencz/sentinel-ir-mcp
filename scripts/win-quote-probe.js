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
const projects = [project, path.join(dir, "it's $HOME & co")];
fs.mkdirSync(projects[1]);
const expected = (tool, folder) => tool === "vscode"
    ? ["--add-mcp", JSON.stringify({ name: "sentinel-ir", type: "stdio", command: "npx", args: ["-y", "sentinel-ir-mcp@0.2", folder] })]
    : ["mcp", "add", "--transport", "stdio", "sentinel-ir", "--", "cmd", "/c", "npx", "-y", "sentinel-ir-mcp@0.2", folder];

const shells = [];
const has = (exe) => spawnSync("where", [exe], { encoding: "utf8" }).status === 0;
if (has("powershell.exe")) shells.push({ name: "powershell5", run: (f) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { env, encoding: "utf8" }), ext: ".ps1" });
if (has("pwsh.exe")) shells.push({ name: "pwsh7", run: (f) => spawnSync("pwsh.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { env, encoding: "utf8" }), ext: ".ps1" });
shells.push({ name: "cmd", run: (f) => spawnSync("cmd.exe", ["/d", "/c", f], { env, encoding: "utf8" }), ext: ".cmd" });

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
            if (line === null) {
                results.push({ shell: shell.name, tool, folder, ok: true, note: "no command printed; setup prints the install link" });
                console.log(`SKIP ${shell.name} ${tool} [${path.basename(folder)}]: setup prints the install link instead`);
                continue;
            }
            const r = shell.run(writeScript(shell.ext === ".cmd" ? `@${line}` : line, shell.ext));
            let got;
            try { got = JSON.parse(r.stdout); } catch { got = { stdout: r.stdout, stderr: r.stderr }; }
            const ok = JSON.stringify(got) === JSON.stringify(expected(tool, folder));
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
