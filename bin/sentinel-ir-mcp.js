#!/usr/bin/env node
"use strict";

// stdout carries the MCP protocol; keep any stray logging off it.
console.log = console.info = console.debug = (...args) => console.error(...args);

const fs = require("fs");
const path = require("path");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer, DEFAULT_LIMITS } = require("../src/server");
const { version } = require("../package.json");

const USAGE = `sentinel-ir-mcp ${version} — MCP server for sentinel-ir (JavaScript and TypeScript)

Usage: sentinel-ir-mcp [options] [folder ...]
       sentinel-ir-mcp setup | doctor | guide [--help]

  setup                  Connect Sentinel-IR to an AI client (shows the change first)
  doctor                 Check Node.js, the client config and a real MCP connection
  guide                  Print short usage instructions for AI agents

  folder                 Folder(s) the file tools may read. A folder named like a
                         command must be written as ./setup, ./doctor or ./guide. Without folders the
                         server uses the MCP roots offered by the client; if the
                         client offers none, only analyze_code works.
  --max-file-bytes <n>   Largest file to analyze (default ${DEFAULT_LIMITS.maxFileBytes})
  --max-files <n>        Default file limit for analyze_directory (default ${DEFAULT_LIMITS.maxFiles}, max ${DEFAULT_LIMITS.hardMaxFiles})
  -h, --help             Show this help
  -v, --version          Show the version

The server only reads files. It never writes, executes or uses the network.
Only "setup" writes, and only the client config file you confirm.`;

function die(message) {
    process.stderr.write(`sentinel-ir-mcp: ${message}\n\n${USAGE}\n`);
    process.exit(2);
}

function parseArgs(argv) {
    const opts = { roots: [] };
    for (let i = 0; i < argv.length; i++) {
        let arg = argv[i];
        let value;
        if (arg.startsWith("--") && arg.includes("=")) [arg, value] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
        if (arg === "-h" || arg === "--help") { process.stdout.write(USAGE + "\n"); process.exit(0); }
        if (arg === "-v" || arg === "--version") { process.stdout.write(version + "\n"); process.exit(0); }
        if (arg === "--max-file-bytes" || arg === "--max-files") {
            if (value === undefined) value = argv[++i];
            const n = Number(value);
            const max = arg === "--max-files" ? DEFAULT_LIMITS.hardMaxFiles : Number.MAX_SAFE_INTEGER;
            if (!Number.isInteger(n) || n < 1 || n > max) die(`${arg} must be an integer between 1 and ${max}`);
            opts[arg === "--max-files" ? "maxFiles" : "maxFileBytes"] = n;
        } else if (arg.startsWith("-")) {
            die(`unknown option ${arg}`);
        } else {
            const dir = path.resolve(arg);
            let isDir = false;
            try { isDir = fs.statSync(dir).isDirectory(); } catch { /* reported below */ }
            if (!isDir) die(`not a folder: ${arg}`);
            opts.roots.push(dir);
        }
    }
    return opts;
}

async function main() {
    const argv = process.argv.slice(2);
    const { COMMANDS, runCommand } = require("../src/cli");
    if (argv.length && COMMANDS.includes(argv[0])) {
        process.exitCode = await runCommand(argv[0], argv.slice(1));
        return;
    }
    const server = createServer(parseArgs(process.argv.slice(2)));
    await server.connect(new StdioServerTransport());
}

main().catch((err) => {
    process.stderr.write(`sentinel-ir-mcp: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
