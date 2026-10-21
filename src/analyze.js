"use strict";

const fs = require("fs/promises");
const path = require("path");
const { analyzeAsync, compress } = require("sentinel-ir");
const { AccessError, resolveInside, isJavaScriptFile } = require("./paths");

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const RISK_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

async function analyzeCode(code, target) {
    const ir = await analyzeAsync(code, typeof target === "string" && target ? { target } : {});
    return compress(ir);
}

async function analyzeFile(requested, roots, { maxFileBytes }) {
    const { real, display } = resolveInside(requested, roots);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw new AccessError(`Not a file: ${requested}`);
    if (!isJavaScriptFile(real)) {
        throw new AccessError(`Unsupported file type: ${requested} (only .js, .mjs and .cjs)`);
    }
    if (stat.size > maxFileBytes) {
        throw new AccessError(`File too large: ${requested} is ${stat.size} bytes, limit is ${maxFileBytes}`);
    }
    const code = await fs.readFile(real, "utf8");
    return analyzeCode(code, display);
}

// Breadth-first, sorted walk. Symlinks are never followed; node_modules, .git
// and hidden folders are skipped.
async function collectFiles(dir, root, { maxFiles, maxFileBytes, recursive }) {
    const files = [];
    const skipped = { tooLarge: [], symlinks: 0 };
    let truncated = false;
    const queue = [dir];
    while (queue.length && !truncated) {
        const current = queue.shift();
        const entries = (await fs.readdir(current, { withFileTypes: true }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            const rel = path.relative(root, full).split(path.sep).join("/");
            if (entry.isSymbolicLink()) {
                skipped.symlinks++;
            } else if (entry.isDirectory()) {
                if (recursive && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(full);
            } else if (entry.isFile() && isJavaScriptFile(entry.name)) {
                const { size } = await fs.stat(full);
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

async function analyzeDirectory(requested, roots, { maxFiles, maxFileBytes, recursive = true }) {
    const { real, root, display } = resolveInside(requested, roots);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new AccessError(`Not a folder: ${requested}`);

    const { files, skipped, truncated } = await collectFiles(real, root, { maxFiles, maxFileBytes, recursive });
    const results = [];
    for (const { full, rel } of files) {
        const ir = await analyzeCode(await fs.readFile(full, "utf8"), rel);
        results.push({
            path: rel,
            analysisStatus: ir.analysisStatus,
            risk: ir.world.risk,
            objective: ir.mission.objective,
            forbidden: ir.forbidden,
            lines: ir.summary.lines,
            facts: ir.facts
        });
    }
    results.sort((a, b) =>
        ((RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const riskCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of results) if (r.risk in riskCounts) riskCounts[r.risk]++;

    return {
        folder: display,
        analyzed: results.length,
        truncated,
        maxFiles,
        skipped,
        riskCounts,
        files: results
    };
}

module.exports = { analyzeCode, analyzeFile, analyzeDirectory, SKIP_DIRS };
