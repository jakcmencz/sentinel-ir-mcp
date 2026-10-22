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
fs.writeFileSync(path.join(dir, "code.cmd"), `@node "%~dp0argv.js" %*\r\n`);
// How `claude` can resolve: npm global install (claude.ps1 next to claude.cmd;
// PowerShell picks the .ps1), cmd.exe on the same install (claude.cmd), and the
// native installer (claude.exe; here a copy of node.exe whose preload prints argv).
const shim = (name) => { const d = path.join(dir, `shim-${name}`); fs.mkdirSync(d); return d; };
const npmShim = shim("npm");
fs.writeFileSync(path.join(npmShim, "claude.cmd"), `@node "%~dp0..\\argv.js" %*\r\n`);
fs.writeFileSync(path.join(npmShim, "claude.ps1"), `$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& "${process.execPath}" "$basedir\\..\\argv.js" $args\r\nexit $LASTEXITCODE\r\n`);
const exeShim = shim("exe");
fs.copyFileSync(process.execPath, path.join(exeShim, "claude.exe"));
fs.writeFileSync(path.join(dir, "pre.js"), "const a = process.argv.slice(1); a[0] = require('path').basename(a[0]); process.stdout.write(JSON.stringify(a)); process.exit(0);");
const basePath = `${dir};${process.env.Path || process.env.PATH}`;
const envFor = (shimDir, extra = {}) => { const e = { ...process.env, ...extra, Path: `${shimDir};${basePath}` }; delete e.PATH; return e; };
const claudeVariants = [
    { name: "claude(npm)", env: envFor(npmShim) },
    { name: "claude(exe)", env: envFor(exeShim, { NODE_OPTIONS: `--require "${path.join(dir, "pre.js").replace(/\\/g, "/")}"` }) }
];
const env = envFor(npmShim);

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
if (has("powershell.exe")) shells.push({ name: "powershell5", run: (f, e = env) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { env: e, encoding: "utf8" }), ext: ".ps1" });
if (has("pwsh.exe")) shells.push({ name: "pwsh7", run: (f, e = env) => spawnSync("pwsh.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { env: e, encoding: "utf8" }), ext: ".ps1" });
// A command line given to cmd /c is parsed like a line typed at the prompt
// (unlike a .cmd file, where a lone % is dropped).
shells.push({ name: "cmd", run: (line, e = env) => spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { env: e, encoding: "utf8", windowsVerbatimArguments: true }), line: true });

const results = [];
for (const shell of shells) {
    if (shell.name.startsWith("pwsh") || shell.name.startsWith("powershell")) {
        const v = shell.run(writeScript("$PSVersionTable.PSVersion.ToString()", shell.ext));
        console.log(`${shell.name}: version ${String(v.stdout).trim()}`);
    }
    const kind = shell.name === "cmd" ? "cmd" : "powershell";
    for (const folder of projects) {
        for (const [tool, client, variant] of [["vscode", "vscode", { name: "vscode", env }], ...claudeVariants.map((v) => ["claude", "claude-code", v])]) {
            const line = installCommand(client, folder, "win32", kind);
            const r = shell.run(shell.line ? line : writeScript(line, shell.ext), variant.env);
            let got;
            try { got = JSON.parse(r.stdout); } catch { got = { stdout: r.stdout, stderr: r.stderr }; }
            const ok = matches(tool, folder, got);
            results.push({ shell: shell.name, tool: variant.name, folder, line, ok, got: ok ? undefined : got });
            console.log(`${ok ? "OK  " : "BAD "} ${shell.name} ${variant.name} [${path.basename(folder)}]: ${line}${ok ? "" : ` -> ${JSON.stringify(got).slice(0, 300)}`}`);
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
