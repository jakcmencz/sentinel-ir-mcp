"use strict";

const os = require("os");
const path = require("path");

const { version } = require("../package.json");

const SERVER_NAME = "sentinel-ir";
// An npm dist-tag, not a range: npx keeps starting a cached copy that still
// satisfies a range such as @0.5, but resolves a tag again on every start.
const STABLE_TAG = `stable-${version.split(".").slice(0, 2).join(".")}`;
const PACKAGE_SPEC = `sentinel-ir-mcp@${STABLE_TAG}`;
const WORKSPACE_VAR = "${workspaceFolder}";

function homeOf(env) {
    return env.HOME || env.USERPROFILE || os.homedir();
}

function configHome(env) {
    return env.XDG_CONFIG_HOME || path.join(homeOf(env), ".config");
}

// Clients whose MCP config file is documented as JSON with a top-level
// "mcpServers" object ("file"), and clients that ship their own install
// command ("command"), for which setup only prints that command.
const CLIENTS = Object.freeze({
    cursor: {
        label: "Cursor",
        kind: "file",
        configPath: ({ project, global, env }) => global
            ? path.join(homeOf(env), ".cursor", "mcp.json")
            : path.join(project, ".cursor", "mcp.json"),
        // In a project config, ${workspaceFolder} keeps the file portable.
        folderArg: ({ project, global }) => (global ? project : WORKSPACE_VAR)
    },
    windsurf: {
        label: "Windsurf",
        kind: "file",
        // Windsurf 3 (Devin Desktop) reads this file and offers to copy the
        // old ~/.codeium/windsurf one; setup copies it the same way.
        configPath: ({ env, platform }) => platform === "win32"
            ? (env.APPDATA ? path.join(env.APPDATA, "devin", "mcp_config.json") : null)
            : path.join(configHome(env), "devin", "mcp_config.json"),
        legacyConfigPath: ({ env }) => path.join(homeOf(env), ".codeium", "windsurf", "mcp_config.json")
    },
    "claude-desktop": {
        label: "Claude Desktop",
        kind: "file",
        configPath: ({ env, platform }) => {
            if (platform === "darwin") {
                return path.join(homeOf(env), "Library", "Application Support", "Claude", "claude_desktop_config.json");
            }
            if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "Claude", "claude_desktop_config.json");
            return null;
        }
    },
    vscode: { label: "VS Code", kind: "command" },
    "claude-code": { label: "Claude Code", kind: "command" }
});

const CLIENT_NAMES = Object.freeze(Object.keys(CLIENTS));
const FILE_CLIENTS = Object.freeze(CLIENT_NAMES.filter((name) => CLIENTS[name].kind === "file"));

function excludeArgs(exclude = []) {
    return exclude.map((p) => `--exclude=${p}`);
}

// audit: null = off, { dir: null } = the default folder, { dir } = that folder.
function auditArgs(audit) {
    if (!audit) return [];
    return [audit.dir ? `--audit-log=${audit.dir}` : "--audit-log"];
}

function serverFlags(exclude = [], audit = null) {
    return [...excludeArgs(exclude), ...auditArgs(audit)];
}

function entryAuditLog(args) {
    let audit = null;
    for (const raw of args) {
        const a = String(raw);
        if (a === "--audit-log") audit = { dir: null };
        else if (a.startsWith("--audit-log=")) audit = { dir: a.slice("--audit-log=".length) };
    }
    return audit;
}

// Exclusions in an entry's arguments, in both spellings the server accepts.
function entryExcludes(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const a = String(args[i]);
        if (a === "--exclude" && i + 1 < args.length) out.push(String(args[++i]));
        else if (a.startsWith("--exclude=")) out.push(a.slice("--exclude=".length));
    }
    return out;
}

function npxEntry(folder, exclude = [], audit = null) {
    return { command: "npx", args: ["-y", PACKAGE_SPEC, ...serverFlags(exclude, audit), folder] };
}

// On Windows npx is npx.cmd, which a client cannot start without a shell
// (measured: spawn("npx") fails with ENOENT), so the entry goes through cmd /c.
function serverEntry(folder, platform = process.platform, exclude = [], audit = null) {
    const { command, args } = npxEntry(folder, exclude, audit);
    return platform === "win32" ? { command: "cmd", args: ["/c", command, ...args] } : { command, args };
}

function isWindowsNpxWrapper(entry) {
    return Boolean(entry) && typeof entry.command === "string" && /^cmd(\.exe)?$/i.test(entry.command) &&
        Array.isArray(entry.args) && String(entry.args[0]).toLowerCase() === "/c" && /^npx(\.cmd)?$/i.test(String(entry.args[1]));
}

function shellQuote(value) {
    return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value) {
    return `'${value.replace(/'/g, "''")}'`;
}

// One argument quoted by the Windows command-line rules (CommandLineToArgvW).
function windowsArgQuote(value) {
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

function vscodeConfig(project, exclude = [], audit = null) {
    return { name: SERVER_NAME, type: "stdio", ...npxEntry(project, exclude, audit) };
}

// code.cmd/claude.cmd re-read their arguments through cmd.exe, which acts on
// these characters (measured: "&" breaks the line, "%OS%" is expanded); JSON
// \u escapes keep them out of the command line.
function cmdSafeJson(value) {
    return JSON.stringify(value).replace(/[&|<>^%!]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Windows forms were checked in CI against a .cmd shim (like code.cmd and
// claude.cmd) from PowerShell 5.1, PowerShell 7 and cmd.exe.
// Exclusions and audit log folders never contain " & | < > ^ % ! (both are
// checked before they get here).
function installCommand(client, project, platform = process.platform, shell = "powershell", exclude = [], audit = null) {
    const json = JSON.stringify(vscodeConfig(project, exclude, audit));
    const win = platform === "win32";
    if (client === "vscode") {
        if (!win) return `code --add-mcp ${shellQuote(json)}`;
        return `code ${shell === "cmd" ? "" : "--% "}--add-mcp ${windowsArgQuote(cmdSafeJson(vscodeConfig(project, exclude, audit)))}`;
    }
    if (client === "claude-code") {
        const ex = serverFlags(exclude, audit);
        if (win && shell !== "cmd") {
            // PowerShell prefers npm's claude.ps1 shim: a script gets `--` only when quoted, and --% does not apply to it.
            return `claude mcp add --transport stdio ${SERVER_NAME} '--' cmd /c npx -y ${PACKAGE_SPEC} ${ex.map((a) => powershellQuote(a) + " ").join("")}${powershellQuote(project)}`;
        }
        if (win && project.includes("%")) {
            const config = { type: "stdio", ...serverEntry(project, "win32", exclude, audit) };
            return `claude mcp add-json ${SERVER_NAME} ${windowsArgQuote(cmdSafeJson(config))}`;
        }
        const quote = win ? (a) => `"${a}"` : shellQuote;
        return `claude mcp add --transport stdio ${SERVER_NAME} -- ${win ? "cmd /c npx" : "npx"} -y ${PACKAGE_SPEC} ${ex.map((a) => quote(a) + " ").join("")}${quote(project)}`;
    }
    throw new Error(`No install command for ${client}`);
}

// One-click links documented by Cursor and VS Code. A link cannot know the
// project path, so it uses ${workspaceFolder}.
function installLinks() {
    const entry = npxEntry(WORKSPACE_VAR);
    return {
        cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${Buffer.from(JSON.stringify(entry)).toString("base64")}`,
        vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "stdio", ...entry }))}`
    };
}

module.exports = {
    SERVER_NAME, STABLE_TAG, PACKAGE_SPEC, WORKSPACE_VAR, CLIENTS, CLIENT_NAMES, FILE_CLIENTS,
    homeOf, npxEntry, serverEntry, excludeArgs, entryExcludes, serverFlags, entryAuditLog, isWindowsNpxWrapper, shellQuote, powershellQuote, installCommand, installLinks
};
