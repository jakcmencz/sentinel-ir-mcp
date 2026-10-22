"use strict";

// Real-OS smoke test (used by the Windows CI job): pack this checkout, install
// the tarball, run setup/doctor against the real config locations, and
// measure how a client can start `npx -y sentinel-ir-mcp@0.2` on this OS.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, spawn } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const ROOT = path.join(__dirname, "..");
const report = { platform: process.platform, release: os.release(), node: process.version, steps: [] };
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); };
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function rawSpawn(command, args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, { stdio: "pipe", shell: false });
        } catch (e) {
            resolve({ started: false, error: e.code || e.message });
            return;
        }
        child.on("error", (e) => resolve({ started: false, error: e.code || e.message }));
        child.on("spawn", () => { child.kill(); resolve({ started: true }); });
    });
}

async function handshake(command, args, cwd) {
    const client = new Client({ name: "compat-smoke", version: "0" });
    try {
        await client.connect(new StdioClientTransport({ command, args, cwd, stderr: "pipe" }));
        const tools = (await client.listTools()).tools.map((t) => t.name).sort();
        const dir = await client.callTool({ name: "analyze_directory", arguments: {} });
        const s = dir.structuredContent;
        return { ok: tools.length === 3 && !dir.isError, version: client.getServerVersion().version, tools, files: s.files.map((f) => `${f.path}:${f.risk}`), incomplete: s.incomplete };
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        await client.close().catch(() => {});
    }
}

(async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-compat-")));
    const project = path.join(base, "my project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "run.js"), 'require("child_process").exec("ls");\n');
    fs.writeFileSync(path.join(project, "broken.ts"), "export const = ;\n");
    report.appdata = process.env.APPDATA;

    const tgz = sh("npm pack --silent --pack-destination " + JSON.stringify(base), ROOT).trim().split(/\r?\n/).pop();
    const inst = path.join(base, "inst");
    fs.mkdirSync(inst);
    sh("npm init -y", inst);
    sh(`npm install --silent ${JSON.stringify(path.join(base, tgz))}`, inst);
    const bin = path.join(inst, "node_modules", "sentinel-ir-mcp", "bin", "sentinel-ir-mcp.js");
    const cli = (args) => {
        try { return { code: 0, out: execSync(`"${process.execPath}" "${bin}" ${args}`, { cwd: project, encoding: "utf8" }) }; }
        catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
    };
    step("tarball version", true, cli("--version").out.trim());

    const clients = ["win32", "darwin"].includes(process.platform) ? ["claude-desktop", "cursor", "windsurf"] : ["cursor", "windsurf"];
    for (const client of clients) {
        const s = cli(`setup --client ${client} --yes`);
        const file = (s.out.match(/^Config: +(.+?)(?: \(new file\))?$/m) || [])[1];
        let entry;
        try { entry = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["sentinel-ir"]; } catch (e) { entry = String(e.message); }
        step(`setup ${client}`, s.code === 0 && Boolean(entry && entry.args), { file, entry });
        const again = cli(`setup --client ${client} --yes`);
        step(`setup ${client} again is a no-op`, again.code === 0 && /Already set up/.test(again.out), again.code);
        const d = cli(`doctor --client ${client} --json`);
        let r = {};
        try { r = JSON.parse(d.out); } catch { r = { raw: d.out }; }
        step(`doctor ${client}`, d.code === 0 && r.ok === true, (r.checks || []).map((c) => `${c.status}:${c.id}`).join(" ") || r.raw);
    }

    const args = ["-y", "sentinel-ir-mcp@0.2", project];
    report.rawSpawnNpx = await rawSpawn("npx", args);
    console.log("INFO raw spawn('npx', no shell):", JSON.stringify(report.rawSpawnNpx));
    report.sdkNpx = await handshake("npx", args, base);
    console.log("INFO MCP SDK client, command \"npx\":", JSON.stringify(report.sdkNpx));
    if (process.platform === "win32") {
        report.sdkCmdNpx = await handshake("cmd", ["/c", "npx", ...args], base);
        console.log("INFO MCP SDK client, command \"cmd /c npx\":", JSON.stringify(report.sdkCmdNpx));
    }
    step("published sentinel-ir-mcp@0.2 starts through npx from an MCP SDK client", report.sdkNpx.ok || Boolean(report.sdkCmdNpx && report.sdkCmdNpx.ok), "see INFO lines");

    report.npm = sh("npm -v", base).trim();
    const pct = path.join(base, "100% done");
    fs.mkdirSync(pct);
    fs.copyFileSync(path.join(project, "run.js"), path.join(pct, "run.js"));
    const pctArgs = ["-y", "sentinel-ir-mcp@0.2", pct];
    report.npxCwdPercent = process.platform === "win32"
        ? await handshake("cmd", ["/c", "npx", ...pctArgs], pct)
        : await handshake("npx", pctArgs, pct);
    console.log(`INFO npm ${report.npm}, npx started inside a folder whose path contains %:`, JSON.stringify(report.npxCwdPercent));
    report.npxArgPercent = process.platform === "win32"
        ? await handshake("cmd", ["/c", "npx", ...pctArgs], base)
        : await handshake("npx", pctArgs, base);
    console.log("INFO npx started elsewhere, folder argument contains %:", JSON.stringify(report.npxArgPercent));

    const out = path.join(ROOT, `compat-${process.platform}-node${process.versions.node.split(".")[0]}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    fs.rmSync(base, { recursive: true, force: true });
    process.exitCode = report.steps.every((s) => s.ok) ? 0 : 1;
})();
