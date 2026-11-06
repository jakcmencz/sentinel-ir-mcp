"use strict";

const fs = require("fs/promises");
const { constants, realpathSync } = require("fs");
const path = require("path");
const { analyzeAsync, compress } = require("sentinel-ir");
const { AccessError, resolveInside, isInside, isSourceFile } = require("./paths");

// O_NONBLOCK: opening a FIFO swapped in after listing must not block the
// server forever. Neither flag exists on Windows; the inode check covers that.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

class TooLargeError extends AccessError {}
class HardlinkError extends AccessError {}

// Reads the file that is actually opened, not the one checked earlier: the
// path may be swapped for a symlink between the check and the read. The open
// handle must be a regular file whose inode is the one now found at a real
// path inside the allowed folders, and at most maxFileBytes are read.
async function readInside(full, roots, maxFileBytes, label) {
    let handle;
    try {
        handle = await fs.open(full, OPEN_FLAGS);
    } catch (err) {
        if (err && err.code === "ELOOP") throw new AccessError(`Access denied: ${label} is a symlink`);
        throw err;
    }
    try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile()) throw new AccessError(`Not a file: ${label}`);
        if (opened.size > BigInt(maxFileBytes)) {
            throw new TooLargeError(`File too large: ${label} is ${opened.size} bytes, limit is ${maxFileBytes}`);
        }
        // Same realpath as resolveInside: on Windows fs.promises.realpath
        // expands 8.3 short names (GITLAB~1) and would never match the roots.
        const real = realpathSync(full);
        const current = await fs.stat(real, { bigint: true });
        if (!roots.some((r) => isInside(real, r)) || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw new AccessError(`Access denied: ${label} changed while it was being read`);
        }
        // Another name of the same file may lie outside the allowed folders,
        // and where it lies cannot be found out, so such files are refused.
        // Both counts: the handle's alone can read 1 while the path is swapped.
        const links = opened.nlink > current.nlink ? opened.nlink : current.nlink;
        if (links > 1n) {
            throw new HardlinkError(`Access denied: ${label} has ${links} hard links; files with more than one are refused`);
        }
        const buffer = Buffer.alloc(Number(opened.size) + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length > maxFileBytes) throw new TooLargeError(`File too large: ${label} grew past the limit of ${maxFileBytes} bytes`);
        if (length === buffer.length) throw new AccessError(`Access denied: ${label} changed while it was being read`);
        return buffer.toString("utf8", 0, length);
    } finally {
        await handle.close();
    }
}

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "venv", "site-packages"]);
const RISK_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

async function analyzeCode(code, target, language) {
    const options = {};
    if (typeof target === "string" && target) options.target = target;
    if (typeof language === "string" && language) options.language = language;
    const ir = await analyzeAsync(code, options);
    return compress(ir);
}

async function analyzeFile(requested, roots, { maxFileBytes }) {
    const { real, display } = resolveInside(requested, roots);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new AccessError(`Not a file: ${requested}`);
    if (!isSourceFile(real)) {
        throw new AccessError(`Unsupported file type: ${requested} (only .js, .mjs, .cjs, .ts, .mts, .cts, .tsx, .py and .pyi)`);
    }
    if (stat.size > maxFileBytes) {
        throw new AccessError(`File too large: ${requested} is ${stat.size} bytes, limit is ${maxFileBytes}`);
    }
    const code = await readInside(real, roots, maxFileBytes, requested);
    return analyzeCode(code, display);
}

// Breadth-first, sorted walk. Symlinks are never followed; node_modules, .git,
// __pycache__, venv, site-packages and hidden folders are skipped.
async function collectFiles(dir, root, { maxFiles, maxFileBytes, recursive }) {
    const files = [];
    const skipped = { tooLarge: [], symlinks: 0, unreadable: [], hardlinks: [] };
    let truncated = false;
    const queue = [dir];
    while (queue.length && !truncated) {
        const current = queue.shift();
        let entries;
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            // Removed or made unreadable while the scan runs.
            skipped.unreadable.push(path.relative(root, current).split(path.sep).join("/") || ".");
            continue;
        }
        entries = entries
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            const rel = path.relative(root, full).split(path.sep).join("/");
            if (entry.isSymbolicLink()) {
                skipped.symlinks++;
            } else if (entry.isDirectory()) {
                if (recursive && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(full);
            } else if (entry.isFile() && isSourceFile(entry.name)) {
                let size;
                try {
                    ({ size } = await fs.lstat(full));
                } catch {
                    skipped.unreadable.push(rel);
                    continue;
                }
                if (size > maxFileBytes) {
                    skipped.tooLarge.push(rel);
                } else if (files.length >= maxFiles) {
                    truncated = true;
                    break;
                } else {
                    files.push({ full, rel });
                }
            }
        }
    }
    return { files, skipped, truncated };
}

// Signal kinds by the risk level they set (sentinel-ir riskOf). Kinds that do
// not set a level (process_exit, secret_access) are only in analyze_file.
const SIGNAL_RISK = {
    dynamic_code: "critical", process_spawn: "critical", child_process_import: "critical",
    unsafe_deserialization: "critical", native_code: "critical",
    destructive_fs: "high",
    disk_write: "medium", outbound_http: "medium", inbound_http: "medium",
    crypto_use: "medium", secret_comparison: "medium"
};
const SUMMARY_SIGNALS = 3;
const SIGNAL_CHARS = 120;

// Signals quote code (a 5000-character identifier stays 5000 characters), so
// the code part is cut; kind and line are kept.
function shortSignal(signal) {
    if (signal.length <= SIGNAL_CHARS) return signal;
    const at = signal.lastIndexOf("@");
    const line = at > 0 ? signal.slice(at) : "";
    return signal.slice(0, SIGNAL_CHARS - line.length - 1) + "\u2026" + line;
}

// The short entry analyze_directory returns by default: enough to rank files
// and see why each has its risk, without the full facts.
function summaryEntry(rel, ir) {
    const risk = ir.world.risk;
    const signals = (ir.facts.riskSignals || []).filter((s) => SIGNAL_RISK[s.slice(0, s.indexOf(":"))] === risk);
    const entry = {
        path: rel,
        risk,
        analysisStatus: ir.analysisStatus,
        language: ir.language,
        lines: ir.summary.lines,
        operations: ir.facts.operations || [],
        riskSignals: signals.slice(0, SUMMARY_SIGNALS).map(shortSignal)
    };
    if (signals.length > SUMMARY_SIGNALS) entry.moreRiskSignals = signals.length - SUMMARY_SIGNALS;
    if (ir.facts.parseError) entry.parseError = ir.facts.parseError;
    return entry;
}

function fullEntry(rel, ir) {
    return {
        path: rel,
        analysisStatus: ir.analysisStatus,
        language: ir.language,
        risk: ir.world.risk,
        objective: ir.mission.objective,
        forbidden: ir.forbidden,
        lines: ir.summary.lines,
        facts: ir.facts
    };
}

async function analyzeDirectory(
    requested,
    roots,
    { maxFiles, maxFileBytes, recursive = true, timeBudgetMs = Infinity, detail = "summary" }
) {
    const started = Date.now();
    const { real, root, display } = resolveInside(requested, roots);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new AccessError(`Not a folder: ${requested}`);

    const { files, skipped, truncated } = await collectFiles(real, root, { maxFiles, maxFileBytes, recursive });
    const results = [];
    const notAnalyzed = [];
    for (const { full, rel } of files) {
        // A running analysis cannot be interrupted, so the budget only stops
        // new files from starting; the rest are listed in notAnalyzed.
        if (notAnalyzed.length || Date.now() - started >= timeBudgetMs) {
            notAnalyzed.push(rel);
            continue;
        }
        // One file that cannot be read or analyzed must not hide the others.
        let ir;
        try {
            ir = await analyzeCode(await readInside(full, [root], maxFileBytes, rel), rel);
        } catch (err) {
            const list = err instanceof TooLargeError ? skipped.tooLarge
                : err instanceof HardlinkError ? skipped.hardlinks : skipped.unreadable;
            list.push(rel);
            continue;
        }
        results.push(detail === "full" ? fullEntry(rel, ir) : summaryEntry(rel, ir));
    }
    results.sort((a, b) =>
        ((RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const riskCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of results) if (r.risk in riskCounts) riskCounts[r.risk]++;

    // Files whose analysis did not finish are listed on their own: their risk
    // is not reliable, so sorting alone would bury them under riskier files.
    const incomplete = results.filter((r) => r.analysisStatus !== "complete").map((r) => r.path).sort();
    const statusCounts = { complete: results.length - incomplete.length, incomplete: incomplete.length };

    return {
        folder: display,
        analyzed: results.length,
        truncated,
        maxFiles,
        detail,
        timedOut: notAnalyzed.length > 0,
        notAnalyzed,
        skipped,
        riskCounts,
        statusCounts,
        incomplete,
        files: results
    };
}

module.exports = { analyzeCode, analyzeFile, analyzeDirectory, readInside, summaryEntry, SKIP_DIRS };
