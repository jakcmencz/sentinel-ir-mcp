"use strict";

const fs = require("fs");
const path = require("path");
const { homeOf } = require("./clients");

// An optional record, for the user, of what the agent asked this server for.
// One JSON object per line in one file per local day; never any source code.
// Turned on only by the user (--audit-log on the command line the client
// starts), never by the agent or by files in the project.

const FILE_RE = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const KEEP_DAYS = 30;
const MAX_DAY_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 300;
const MAX_LISTED = 20;
// Characters cmd.exe acts on: an MCP entry on Windows runs through "cmd /c".
const UNSAFE_DIR = /["&|<>^%!\u0000-\u001f]/;
const OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);

class AuditLogError extends Error {}

function defaultAuditDir(env = process.env, platform = process.platform) {
    if (platform === "win32") {
        const local = env.LOCALAPPDATA || path.join(homeOf(env), "AppData", "Local");
        return path.join(local, "sentinel-ir-mcp", "audit-log");
    }
    if (platform === "darwin") return path.join(homeOf(env), "Library", "Logs", "sentinel-ir-mcp");
    const state = env.XDG_STATE_HOME || path.join(homeOf(env), ".local", "state");
    return path.join(state, "sentinel-ir-mcp", "audit-log");
}

// "--audit-log" (default folder) or "--audit-log=<folder>"; must be absolute
// because a client starts the server from a folder you do not choose.
function normalizeAuditDir(raw) {
    if (typeof raw !== "string" || raw.trim() === "") throw new AuditLogError("--audit-log=<folder> needs a folder");
    const dir = raw.trim();
    if (UNSAFE_DIR.test(dir)) throw new AuditLogError(`audit log folder "${raw}" contains a character that is not allowed (" & | < > ^ % !)`);
    if (!path.isAbsolute(dir)) throw new AuditLogError(`audit log folder "${raw}" must be a full path, e.g. ${process.platform === "win32" ? "C:\\logs\\sentinel" : "/home/me/logs"}`);
    return path.resolve(dir);
}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realOrResolved(p) {
    // The folder may not exist yet: resolve its nearest existing parent.
    let current = path.resolve(p);
    const rest = [];
    for (;;) {
        try { return path.join(fs.realpathSync(current), ...rest.reverse()); } catch { /* go up */ }
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(p);
        rest.push(path.basename(current));
        current = parent;
    }
}

// A log inside the project could be committed or read by the agent.
function assertOutsideProjects(dir, projects, caseInsensitive = process.platform === "win32" || process.platform === "darwin") {
    const fold = (p) => (caseInsensitive ? p.toLowerCase() : p);
    const real = fold(realOrResolved(dir));
    for (const project of projects) {
        if (isInside(real, fold(realOrResolved(project)))) {
            throw new AuditLogError(`the audit log folder ${dir} is inside the project folder ${project}; pick a folder outside it`);
        }
    }
}

function pad(n) { return String(n).padStart(2, "0"); }
function dayName(date) { return `audit-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`; }

function cut(value, max = MAX_TEXT) {
    if (typeof value !== "string") return value;
    if (value.length <= max) return value;
    let end = max;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    return value.slice(0, end) + "…";
}

function logFiles(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => FILE_RE.test(n)).sort();
}

function pruneOld(dir, now) {
    const limit = new Date(now);
    limit.setHours(0, 0, 0, 0);
    limit.setDate(limit.getDate() - KEEP_DAYS);
    for (const name of logFiles(dir)) {
        const [, y, m, d] = FILE_RE.exec(name);
        if (new Date(Number(y), Number(m) - 1, Number(d)) < limit) {
            try {
                if (fs.lstatSync(path.join(dir, name)).isFile()) fs.unlinkSync(path.join(dir, name));
            } catch { /* another server may have removed it */ }
        }
    }
}

// What a tool call is logged as: what was asked and the outcome, no code.
function describeCall(tool, args, outcome) {
    const entry = { tool };
    if (tool === "analyze_code") {
        entry.bytes = Buffer.byteLength(typeof args.code === "string" ? args.code : "", "utf8");
        if (typeof args.target === "string") entry.target = cut(args.target);
        if (typeof args.language === "string") entry.language = args.language;
    } else {
        entry.path = cut(typeof args.path === "string" ? args.path : ".");
        if (tool === "analyze_directory") {
            for (const [k, v] of [["max_files", args.max_files], ["recursive", args.recursive], ["detail", args.detail]]) if (v !== undefined) entry[k] = v;
        }
    }
    if (outcome.error) {
        entry.ok = false;
        entry.reason = outcome.reason;
        entry.message = cut(outcome.error);
        return entry;
    }
    entry.ok = true;
    const r = outcome.result;
    if (tool === "analyze_directory") {
        entry.analyzed = r.analyzed;
        entry.riskCounts = r.riskCounts;
        entry.incomplete = r.incomplete.length;
        entry.excluded = r.skipped.excluded;
        const notRead = r.skipped.tooLarge.length + r.skipped.unreadable.length + r.skipped.hardlinks.length;
        if (notRead) entry.notRead = notRead;
        if (r.truncated) entry.truncated = true;
        if (r.timedOut) entry.timedOut = true;
        const top = r.files.filter((f) => f.risk === "critical" || f.risk === "high").slice(0, MAX_LISTED);
        if (top.length) entry.top = top.map((f) => ({ path: cut(f.path), risk: f.risk }));
    } else {
        entry.risk = r.world && r.world.risk;
        entry.analysisStatus = r.analysisStatus;
        entry.language = r.language;
        if (tool === "analyze_file" && r.mission && typeof r.mission.target === "string") entry.file = cut(r.mission.target);
    }
    return entry;
}

function createAuditLog({ dir, now = () => Date.now(), onError = (m) => process.stderr.write(`sentinel-ir-mcp: ${m}\n`) } = {}) {
    if (!dir) return { active: false, record() {}, flush: async () => {} };
    let queue = Promise.resolve();
    let prunedFor = null;
    let fullDay = null;
    let failed = false;

    async function append(line, file) {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        // Once per server and day, so a server running for weeks still cleans up.
        if (prunedFor !== file) { prunedFor = file; pruneOld(dir, now()); }
        const handle = await fs.promises.open(file, OPEN_FLAGS, 0o600);
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
            if (stat.size >= MAX_DAY_BYTES) {
                if (fullDay !== file) {
                    fullDay = file;
                    await handle.write(JSON.stringify({ ts: new Date(now()).toISOString(), event: "full", limitBytes: MAX_DAY_BYTES }) + "\n");
                }
                return;
            }
            // One write per line: with O_APPEND lines of parallel servers do not interleave.
            await handle.write(line);
        } finally {
            await handle.close();
        }
    }

    function record(entry) {
        const date = new Date(now());
        const line = JSON.stringify({ ts: date.toISOString(), pid: process.pid, ...entry }) + "\n";
        const file = path.join(dir, dayName(date));
        queue = queue.then(() => append(line, file)).then(() => { failed = false; }, (err) => {
            if (!failed) onError(`cannot write the audit log in ${dir}: ${err.message}`);
            failed = true;
        });
    }

    return { active: true, dir, record, flush: () => queue };
}

module.exports = {
    AuditLogError, KEEP_DAYS, MAX_DAY_BYTES, FILE_RE,
    defaultAuditDir, normalizeAuditDir, assertOutsideProjects, createAuditLog, describeCall, logFiles, dayName, cut
};
