"use strict";

const os = require("os");
const path = require("path");

const SERVER_NAME = "sentinel-ir";
const PACKAGE_SPEC = "sentinel-ir-mcp@0.2";
const WORKSPACE_VAR = "${workspaceFolder}";

function homeOf(env) {
    return env.HOME || env.USERPROFILE || os.homedir();
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
        configPath: ({ env }) => path.join(homeOf(env), ".codeium", "windsurf", "mcp_config.json")
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

function serverEntry(folder) {
    return { command: "npx", args: ["-y", PACKAGE_SPEC, folder] };
}

function shellQuote(value) {
    return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function vscodeConfig(project) {
    return { name: SERVER_NAME, type: "stdio", ...serverEntry(project) };
}

function installCommand(client, project) {
    if (client === "vscode") return `code --add-mcp ${shellQuote(JSON.stringify(vscodeConfig(project)))}`;
    if (client === "claude-code") {
        return `claude mcp add --transport stdio ${SERVER_NAME} -- npx -y ${PACKAGE_SPEC} ${shellQuote(project)}`;
    }
    throw new Error(`No install command for ${client}`);
}

// One-click links documented by Cursor and VS Code. A link cannot know the
// project path, so it uses ${workspaceFolder}.
function installLinks() {
    const entry = serverEntry(WORKSPACE_VAR);
    return {
        cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${Buffer.from(JSON.stringify(entry)).toString("base64")}`,
        vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: "stdio", ...entry }))}`
    };
}

module.exports = {
    SERVER_NAME, PACKAGE_SPEC, WORKSPACE_VAR, CLIENTS, CLIENT_NAMES, FILE_CLIENTS,
    homeOf, serverEntry, shellQuote, installCommand, installLinks
};
