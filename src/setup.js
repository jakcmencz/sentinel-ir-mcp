"use strict";

const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { SERVER_NAME, PACKAGE_SPEC, CLIENTS, homeOf, serverEntry, installCommand } = require("./clients");

class SetupError extends Error {}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function realpathOr(p) {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// The agent gets exactly one project folder: never a disk root or the home folder.
function validateProject(dir, env) {
    let real;
    try {
        real = fs.realpathSync(path.resolve(dir));
    } catch {
        throw new SetupError(`Project folder not found: ${dir}`);
    }
    if (!fs.statSync(real).isDirectory()) throw new SetupError(`Not a folder: ${dir}`);
    if (path.parse(real).root === real) {
        throw new SetupError(`Refusing to give the agent access to a whole disk (${real}). Pass a project folder with --project.`);
    }
    if (real === realpathOr(homeOf(env))) {
        throw new SetupError(`Refusing to give the agent access to your whole home folder (${real}). Pass a project folder with --project.`);
    }
    return real;
}

function detectIndent(text) {
    const m = text.match(/^([ \t]+)"/m);
    return m ? m[1] : 2;
}

function readConfig(file) {
    if (!fs.existsSync(file)) return { exists: false, original: null, data: {} };
    const original = fs.readFileSync(file, "utf8");
    const body = original.replace(/^\uFEFF/, "");
    let data = {};
    if (body.trim() !== "") {
        try {
            data = JSON.parse(body);
        } catch (err) {
            throw new SetupError(`${file} is not valid JSON (${err.message}). Fix or move it, then run setup again. Nothing was changed.`);
        }
    }
    if (!isPlainObject(data)) throw new SetupError(`${file} does not contain a JSON object. Nothing was changed.`);
    if (data.mcpServers !== undefined && !isPlainObject(data.mcpServers)) {
        throw new SetupError(`"mcpServers" in ${file} is not an object. Nothing was changed.`);
    }
    return { exists: true, original, data };
}

// seedFile: an older config location whose servers are copied into a new file.
function planFileChange(file, entry, seedFile = null) {
    const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
    const read = readConfig(target);
    const seeded = !read.exists && seedFile && fs.existsSync(seedFile) ? seedFile : null;
    const { exists, original } = read;
    const data = seeded ? readConfig(seeded).data : read.data;
    const servers = data.mcpServers || {};
    const previous = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME) ? servers[SERVER_NAME] : undefined;
    const others = Object.keys(servers).filter((name) => name !== SERVER_NAME);
    const base = { file, target, entry, previous, others, seeded };
    if (previous !== undefined && isDeepStrictEqual(previous, entry)) return { ...base, action: "unchanged" };
    const next = { ...data, mcpServers: { ...servers, [SERVER_NAME]: entry } };
    return {
        ...base,
        action: !exists ? "create" : previous === undefined ? "add" : "update",
        original,
        text: JSON.stringify(next, null, original ? detectIndent(original) : 2) + "\n"
    };
}

function stamp(now) {
    return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Backup, then write to a temp file next to the target and rename over it.
function applyPlan(plan, now = Date.now()) {
    if (plan.action === "unchanged") return { written: false, backup: null };
    const { target } = plan;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let backup = null;
    let mode = 0o644;
    if (plan.original !== null) {
        if (fs.readFileSync(target, "utf8") !== plan.original) {
            throw new SetupError(`${target} changed while setup was running. Nothing was changed; run setup again.`);
        }
        mode = fs.statSync(target).mode & 0o777;
        backup = `${target}.bak-${stamp(now)}`;
        for (let i = 1; fs.existsSync(backup); i++) backup = `${target}.bak-${stamp(now)}-${i}`;
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    }
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, plan.text, { mode, flag: "wx" });
    try {
        fs.renameSync(tmp, target);
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
    }
    return { written: true, backup };
}

function describePlan(client, plan, project) {
    const lines = [
        `Client:  ${CLIENTS[client].label}`,
        `Config:  ${plan.file}${plan.target !== plan.file ? ` (-> ${plan.target})` : ""}${plan.action === "create" ? " (new file)" : ""}`,
        `Access:  ${project} (only this folder, read-only)`,
        `Change:  ${{ create: "create the file with", add: "add", update: "replace", unchanged: "none, already set up:" }[plan.action]} "${SERVER_NAME}"`
    ];
    if (plan.seeded) lines.push(`Copied from: ${plan.seeded} (old location; that file stays unchanged)`);
    if (plan.action === "update") lines.push(`  before: ${JSON.stringify(plan.previous)}`);
    lines.push(`  ${plan.action === "update" ? "after:  " : ""}${JSON.stringify(plan.entry)}`);
    if (plan.others.length) lines.push(`Kept unchanged: ${plan.others.join(", ")}`);
    return lines.join("\n") + "\n";
}

function percentNote(project) {
    return project.includes("%")
        ? "Note: this folder path contains %. npm 10.8 (measured: 10.8.2, 10.8.3) fails with \"npm error URI malformed\" " +
          "when npx is started inside such a folder; npm 10.9.9 and 11.19.1 work. If the client reports that error, update npm " +
          "or use a folder without % in its path.\n"
        : "";
}

async function runSetup(opts, io) {
    const out = (s) => io.stdout.write(s);
    const err = (s) => io.stderr.write(s);
    try {
        let client = opts.client;
        if (!client) {
            if (!io.isTTY || !io.prompt) throw new SetupError(`Choose a client with --client (${Object.keys(CLIENTS).join(", ")}).`);
            const names = Object.keys(CLIENTS);
            out(names.map((n, i) => `  ${i + 1}) ${CLIENTS[n].label}`).join("\n") + "\n");
            const answer = (await io.prompt("Connect Sentinel-IR to which client? [1-" + names.length + "] ")).trim();
            client = names[Number(answer) - 1] || (CLIENTS[answer] ? answer : undefined);
            if (!client) throw new SetupError("No client chosen. Nothing was changed.");
        }
        if (!Object.prototype.hasOwnProperty.call(CLIENTS, client)) {
            throw new SetupError(`Unknown client "${client}". Use one of: ${Object.keys(CLIENTS).join(", ")}.`);
        }
        const spec = CLIENTS[client];
        if (opts.global && client !== "cursor") throw new SetupError("--global only applies to --client cursor.");
        const project = validateProject(opts.project || io.cwd, io.env);

        if (spec.kind === "command") {
            if (opts.config) throw new SetupError(`--config does not apply to ${spec.label}; it installs servers with its own command.`);
            if (io.platform === "win32") {
                out(`${spec.label} adds MCP servers with its own command. Nothing was written. Run in PowerShell:\n\n  ${installCommand(client, project, "win32", "powershell")}\n\n` +
                    `or in Command Prompt (cmd.exe):\n\n  ${installCommand(client, project, "win32", "cmd")}\n\n`);
            } else {
                out(`${spec.label} adds MCP servers with its own command. Nothing was written. Run:\n\n  ${installCommand(client, project, io.platform)}\n\n`);
            }
            out(`Access: ${project} (only this folder, read-only)\n`);
            out(`Then check the connection: npx -y ${PACKAGE_SPEC} doctor --project ${project}\n`);
            out(percentNote(project));
            return 0;
        }

        const ctx = { project, global: Boolean(opts.global), env: io.env, platform: io.platform };
        const file = opts.config ? path.resolve(io.cwd, opts.config) : spec.configPath(ctx);
        if (!file) {
            throw new SetupError(`The ${spec.label} config location is documented for macOS and Windows only. Pass its path with --config <file>.`);
        }
        const folder = opts.config || !spec.folderArg ? project : spec.folderArg(ctx);
        const seed = !opts.config && spec.legacyConfigPath ? spec.legacyConfigPath(ctx) : null;
        const plan = planFileChange(file, serverEntry(folder, io.platform), seed);
        out(describePlan(client, plan, project));
        out(percentNote(project));

        if (plan.action === "unchanged") {
            out("Already set up. Nothing was written.\n");
            return 0;
        }
        if (opts.dryRun) {
            out("Dry run. Nothing was written.\n");
            return 0;
        }
        if (!opts.yes) {
            if (!io.isTTY || !io.prompt) {
                out("Nothing was written. Run again with --yes to apply this change.\n");
                return 1;
            }
            const answer = (await io.prompt("Write this change? [y/N] ")).trim().toLowerCase();
            if (answer !== "y" && answer !== "yes") {
                out("Cancelled. Nothing was written.\n");
                return 1;
            }
        }
        const { backup } = applyPlan(plan, io.now ? io.now() : Date.now());
        out(`Written.${backup ? ` Backup: ${backup}` : ""}\n`);
        out(`Next: restart ${spec.label}, then check the connection:\n  npx -y ${PACKAGE_SPEC} doctor --client ${client}` +
            `${opts.config ? ` --config ${file}` : ""}${client === "cursor" && !opts.global ? ` --project ${project}` : ""}\n`);
        out(`Optional instructions for your agent: npx -y ${PACKAGE_SPEC} guide\n`);
        return 0;
    } catch (e) {
        if (e instanceof SetupError) {
            err(`sentinel-ir-mcp setup: ${e.message}\n`);
            return 1;
        }
        throw e;
    }
}

module.exports = { SetupError, validateProject, readConfig, planFileChange, applyPlan, runSetup };
