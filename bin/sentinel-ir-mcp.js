#!/usr/bin/env node
"use strict";

// stdout carries the MCP protocol; keep any stray logging off it.
console.log = console.info = console.debug = (...args) => console.error(...args);

const fs = require("fs");
const path = require("path");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer, DEFAULT_LIMITS } = require("../src/server");
const { normalizePattern, ExcludeError, MAX_PATTERNS } = require("../src/exclude");
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
  --exclude <name>       A file or folder the file tools must refuse; repeat for more.
                         secrets = any file or folder named so, config/prod.js =
                         this path in an allowed folder, *.min.js = by mask,
                         ** = any folders. Set by you; the project cannot change it.
  --max-file-bytes <n>   Largest file to analyze (default ${DEFAULT_LIMITS.maxFileBytes}, max ${DEFAULT_LIMITS.hardMaxFileBytes})
  --time-budget-ms <n>   analyze_directory starts no new file after this time (default ${DEFAULT_LIMITS.timeBudgetMs}, max ${DEFAULT_LIMITS.hardMaxTimeBudgetMs})
  --max-files <n>        Default file limit for analyze_directory (default ${DEFAULT_LIMITS.maxFiles}, max ${DEFAULT_LIMITS.hardMaxFiles})
  -h, --help             Show this help
  -v, --version          Show the version

The server only reads files. It never writes, executes or uses the network.
Only "setup" writes, and only the client config file you confirm.`;

function die(message) {
    process.stderr.write(`sentinel-ir-mcp: ${message}\n\n${USAGE}\n`);
    process.exit(2);
}

const NUMBER_OPTIONS = {
    "--max-file-bytes": ["maxFileBytes", DEFAULT_LIMITS.hardMaxFileBytes],
    "--max-files": ["maxFiles", DEFAULT_LIMITS.hardMaxFiles],
    "--time-budget-ms": ["timeBudgetMs", DEFAULT_LIMITS.hardMaxTimeBudgetMs]
};

function parseArgs(argv) {
    const opts = { roots: [], exclude: [] };
    for (let i = 0; i < argv.length; i++) {
        let arg = argv[i];
        let value;
        if (arg.startsWith("--") && arg.includes("=")) [arg, value] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
        if (arg === "-h" || arg === "--help") { process.stdout.write(USAGE + "\n"); process.exit(0); }
        if (arg === "-v" || arg === "--version") { process.stdout.write(version + "\n"); process.exit(0); }
        if (Object.hasOwn(NUMBER_OPTIONS, arg)) {
            const [key, max] = NUMBER_OPTIONS[arg];
            if (value === undefined) value = argv[++i];
            const n = Number(value);
            if (!Number.isInteger(n) || n < 1 || n > max) die(`${arg} must be an integer between 1 and ${max}`);
            opts[key] = n;
        } else if (arg === "--exclude") {
            if (value === undefined) value = argv[++i];
            if (value === undefined) die("--exclude needs a value");
            try { opts.exclude.push(normalizePattern(value)); } catch (e) {
                if (!(e instanceof ExcludeError)) throw e;
                die(e.message);
            }
            if (opts.exclude.length > MAX_PATTERNS) die(`at most ${MAX_PATTERNS} --exclude options`);
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
