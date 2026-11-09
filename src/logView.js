"use strict";

const fs = require("fs");
const path = require("path");
const { PACKAGE_SPEC } = require("./clients");
const { AuditLogError, defaultAuditDir, normalizeAuditDir, logFiles, KEEP_DAYS } = require("./auditLog");

const RECENT = 50;
// Control, bidi and line-separator characters could rewrite the terminal or
// fake a line: shown as \u{..} instead.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

function safe(value) {
    return String(value).replace(UNSAFE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
}

const REASONS = {
    excluded: "excluded by your settings",
    outside: "outside the project folder",
    "not-found": "does not exist",
    "too-large": "file too large",
    "no-folders": "no project folder is set"
};

const TOOL_WORDS = { analyze_file: "file", analyze_directory: "folder", analyze_code: "pasted code" };

function pad(n) { return String(n).padStart(2, "0"); }

function localTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "????-??-?? ??:??:??";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function riskCounts(counts) {
    if (!counts || typeof counts !== "object") return "";
    const parts = ["critical", "high", "medium", "low"].filter((k) => Number(counts[k]) > 0).map((k) => `${Number(counts[k])} ${k}`);
    return parts.length ? ` (${parts.join(", ")})` : "";
}

function describe(e) {
    if (e.event === "start") {
        const folders = Array.isArray(e.folders) && e.folders.length ? ` for ${e.folders.map(safe).join(", ")}` : "";
        return [`server started (sentinel-ir-mcp ${safe(e.version)})${folders}`];
    }
    if (e.event === "full") return [`the log for this day reached its size limit; nothing more is written today`];
    const what = TOOL_WORDS[e.tool] ? TOOL_WORDS[e.tool] : safe(e.tool);
    const target = e.tool === "analyze_code" ? `${what} (${Number(e.bytes) || 0} bytes${e.language ? `, ${safe(e.language)}` : ""})` : `${what} ${safe(e.path)}`;
    if (e.ok === false) {
        const reason = REASONS[e.reason] || safe(e.message || e.reason || "failed");
        return [`REFUSED ${target}: ${reason}`];
    }
    if (e.tool === "analyze_directory") {
        const extra = [];
        if (Number(e.excluded) > 0) extra.push(`${Number(e.excluded)} excluded`);
        if (Number(e.notRead) > 0) extra.push(`${Number(e.notRead)} not read (too large or unreadable)`);
        if (e.truncated) extra.push("stopped at the file limit");
        if (e.timedOut) extra.push("stopped at the time limit");
        const lines = [`${target}: ${Number(e.analyzed) || 0} file(s)${riskCounts(e.riskCounts)}${extra.length ? `, ${extra.join(", ")}` : ""}`];
        if (Array.isArray(e.top)) for (const f of e.top) lines.push(`    ${safe(f.risk).padEnd(8)} ${safe(f.path)}`);
        return lines;
    }
    const incomplete = e.analysisStatus && e.analysisStatus !== "complete" ? " (incomplete: broken code)" : "";
    return [`${target}: ${safe(e.risk)}${incomplete}`];
}

function parseFile(file) {
    const entries = [];
    let damaged = 0;
    let text;
    try {
        if (!fs.lstatSync(file).isFile()) return { entries, damaged };
        text = fs.readFileSync(file, "utf8");
    } catch { return { entries, damaged }; }
    for (const line of text.split("\n")) {
        if (line === "") continue;
        try {
            const e = JSON.parse(line);
            if (e && typeof e === "object" && !Array.isArray(e) && (typeof e.tool === "string" || typeof e.event === "string")) entries.push(e);
            else damaged++;
        } catch { damaged++; }
    }
    return { entries, damaged };
}

function printEntry(io, e) {
    const client = e.client ? ` [${safe(e.client).slice(0, 40)}]` : "";
    const [first, ...rest] = describe(e);
    io.stdout.write(`${localTime(e.ts)}${client} ${first}\n`);
    for (const line of rest) io.stdout.write(line + "\n");
}

// Files are read one at a time (a day can hold 50 MB), newest first for the
// default view, which stops once it has enough entries.
function runLog(opts, io) {
    let dir;
    try {
        dir = opts.dir ? normalizeAuditDir(path.resolve(io.cwd, opts.dir)) : defaultAuditDir(io.env, io.platform);
    } catch (e) {
        if (!(e instanceof AuditLogError)) throw e;
        io.stderr.write(`sentinel-ir-mcp log: ${e.message}\n`);
        return 2;
    }
    const files = logFiles(dir).map((n) => path.join(dir, n));
    let damaged = 0;
    let count = 0;
    let more = false;
    let first = true;
    const emit = opts.json
        ? (e) => { io.stdout.write(`${first ? "" : ","}\n    ${JSON.stringify(e)}`); first = false; }
        : (e) => printEntry(io, e);
    if (opts.json) io.stdout.write(`{\n  "folder": ${JSON.stringify(dir)},\n  "entries": [`);
    if (opts.all) {
        for (const file of files) {
            const r = parseFile(file);
            damaged += r.damaged;
            for (const e of r.entries) emit(e);
            count += r.entries.length;
        }
    } else {
        let recent = [];
        for (let i = files.length - 1; i >= 0 && recent.length < RECENT; i--) {
            const r = parseFile(files[i]);
            damaged += r.damaged;
            recent = r.entries.concat(recent);
            if (recent.length >= RECENT && i > 0) more = true;
        }
        if (recent.length > RECENT) { more = true; recent = recent.slice(-RECENT); }
        for (const e of recent) emit(e);
        count = recent.length;
    }
    if (opts.json) {
        io.stdout.write(`${first ? "" : "\n  "}],\n  "damaged": ${damaged}\n}\n`);
        return 0;
    }
    if (count === 0) {
        io.stdout.write(`No audit log in ${dir}.\n` +
            `Turn it on with: npx -y ${PACKAGE_SPEC} setup --audit-log\n` +
            `Then restart the AI app; entries appear when the agent uses the tools.\n`);
    } else {
        const summary = more ? `Showing the last ${count} entries; --all shows everything.` : `${count} entries.`;
        io.stdout.write(`\n${summary} Log folder: ${dir} (kept ${KEEP_DAYS} days)\n`);
    }
    if (damaged) io.stdout.write(`${damaged} damaged line(s) skipped.\n`);
    return 0;
}

module.exports = { runLog, safe, describe };
