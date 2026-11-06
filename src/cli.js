"use strict";

const readline = require("readline");
const { runSetup } = require("./setup");
const { runDoctor } = require("./doctor");
const { GUIDE } = require("./guide");
const { CLIENT_NAMES, PACKAGE_SPEC } = require("./clients");

const COMMANDS = Object.freeze(["setup", "doctor", "guide"]);

const HELP = {
    setup: `Usage: sentinel-ir-mcp setup [--client <name>] [--project <folder>] [--exclude <name>]... [--no-exclude] [--global] [--config <file>] [--dry-run] [--yes]

Adds a "sentinel-ir" server to an AI client's MCP config. Shows the change first,
backs up the old file and touches only the "sentinel-ir" entry.

  --client <name>     ${CLIENT_NAMES.join(", ")}
  --project <folder>  folder the agent may read (default: current folder)
  --exclude <name>    a file or folder the agent must not read; repeat for more.
                      secrets = any file or folder named so, config/prod.js = this
                      path, *.min.js = by mask. Without it, setup asks (Enter = none)
                      and running setup again keeps the current list.
  --no-exclude        remove all exclusions
  --global            Cursor only: ~/.cursor/mcp.json instead of <project>/.cursor/mcp.json
  --config <file>     write this config file instead of the client's default
  --dry-run           show the change, write nothing
  --yes               write without asking`,
    doctor: `Usage: sentinel-ir-mcp doctor [--client <name>] [--project <folder>] [--global] [--config <file>] [--json]

Checks Node.js, the client config and a real MCP connection to this server.
Exit code 0 when all checks pass, 1 otherwise.`,
    guide: `Usage: sentinel-ir-mcp guide

Prints short instructions for AI agents (for AGENTS.md or client rules).
Nothing is written.`
};

const REPEATABLE = new Set(["--exclude"]);

const FLAGS = {
    setup: {
        "--client": "client", "--project": "project", "--config": "config", "--exclude": "exclude",
        "--no-exclude": true, "--global": true, "--dry-run": true, "--yes": true, "-y": true
    },
    doctor: { "--client": "client", "--project": "project", "--config": "config", "--global": true, "--json": true },
    guide: {}
};

class UsageError extends Error {}

function camel(flag) {
    return { "-y": "yes", "--dry-run": "dryRun", "--no-exclude": "noExclude" }[flag] || flag.replace(/^--/, "");
}

function parse(command, argv) {
    const opts = {};
    const spec = FLAGS[command];
    for (let i = 0; i < argv.length; i++) {
        let arg = argv[i];
        let value;
        if (arg === "-h" || arg === "--help") return { help: true };
        if (arg.startsWith("--") && arg.includes("=")) [arg, value] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
        if (!Object.prototype.hasOwnProperty.call(spec, arg)) throw new UsageError(`unknown ${arg.startsWith("-") ? "option" : "argument"} ${arg}`);
        if (spec[arg] === true) {
            if (value !== undefined) throw new UsageError(`${arg} takes no value`);
            opts[camel(arg)] = true;
        } else {
            if (value === undefined) value = argv[++i];
            if (value === undefined || value === "") throw new UsageError(`${arg} needs a value`);
            if (REPEATABLE.has(arg)) (opts[spec[arg]] ||= []).push(value);
            else opts[spec[arg]] = value;
        }
    }
    return opts;
}

function defaultIo() {
    const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    return {
        stdout: process.stdout,
        stderr: process.stderr,
        env: process.env,
        platform: process.platform,
        cwd: process.cwd(),
        isTTY,
        prompt: isTTY ? (question) => new Promise((resolve) => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(question, (answer) => { rl.close(); resolve(answer); });
        }) : null
    };
}

async function runCommand(command, argv, io = defaultIo()) {
    let opts;
    try {
        opts = parse(command, argv);
    } catch (e) {
        if (!(e instanceof UsageError)) throw e;
        io.stderr.write(`sentinel-ir-mcp ${command}: ${e.message}\n\n${HELP[command]}\n`);
        return 2;
    }
    if (opts.help) {
        io.stdout.write(HELP[command] + "\n");
        return 0;
    }
    if (command === "guide") {
        io.stdout.write(GUIDE);
        return 0;
    }
    if (command === "setup") return runSetup(opts, io);
    return runDoctor(opts, io);
}

module.exports = { COMMANDS, runCommand, parse, PACKAGE_SPEC };
