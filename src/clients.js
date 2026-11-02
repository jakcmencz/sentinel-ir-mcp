"use strict";

const os = require("os");
const path = require("path");

const SERVER_NAME = "sentinel-ir";
const PACKAGE_SPEC = "sentinel-ir-mcp@0.4";
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

function npxEntry(folder) {
    return { command: "npx", args: ["-y", PACKAGE_SPEC, folder] };
}

// On Windows npx is npx.cmd, which a client cannot start without a shell
// (measured: spawn("npx") fails with ENOENT), so the entry goes through cmd /c.
function serverEntry(folder, platform = process.platform) {
    const { command, args } = npxEntry(folder);
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

function vscodeConfig(project) {
    return { name: SERVER_NAME, type: "stdio", ...npxEntry(project) };
}

// code.cmd/claude.cmd re-read their arguments through cmd.exe, which acts on
// these characters (measured: "&" breaks the line, "%OS%" is expanded); JSON
// \u escapes keep them out of the command line.
function cmdSafeJson(value) {
    return JSON.stringify(value).replace(/[&|<>^%!]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Windows forms were checked in CI against a .cmd shim (like code.cmd and
// claude.cmd) from PowerShell 5.1, PowerShell 7 and cmd.exe.
function installCommand(client, project, platform = process.platform, shell = "powershell") {
    const json = JSON.stringify(vscodeConfig(project));
    const win = platform === "win32";
    if (client === "vscode") {
        if (!win) return `code --add-mcp ${shellQuote(json)}`;
        return `code ${shell === "cmd" ? "" : "--% "}--add-mcp ${windowsArgQuote(cmdSafeJson(vscodeConfig(project)))}`;
    }
    if (client === "claude-code") {
        if (win && shell !== "cmd") {
            // PowerShell prefers npm's claude.ps1 shim: a script gets `--` only when quoted, and --% does not apply to it.
            return `claude mcp add --transport stdio ${SERVER_NAME} '--' cmd /c npx -y ${PACKAGE_SPEC} ${powershellQuote(project)}`;
        }
        if (win && project.includes("%")) {
            const config = { type: "stdio", ...serverEntry(project, "win32") };
            return `claude mcp add-json ${SERVER_NAME} ${windowsArgQuote(cmdSafeJson(config))}`;
        }
        return `claude mcp add --transport stdio ${SERVER_NAME} -- ${win ? "cmd /c npx" : "npx"} -y ${PACKAGE_SPEC} ${win ? `"${project}"` : shellQuote(project)}`;
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
    SERVER_NAME, PACKAGE_SPEC, WORKSPACE_VAR, CLIENTS, CLIENT_NAMES, FILE_CLIENTS,
    homeOf, npxEntry, serverEntry, isWindowsNpxWrapper, shellQuote, powershellQuote, installCommand, installLinks
};
