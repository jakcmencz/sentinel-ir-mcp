"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx"]);
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);
const PY_EXTENSIONS = new Set([".py", ".pyi"]);
const RS_EXTENSIONS = new Set([".rs"]);
const SOURCE_EXTENSIONS = new Set([...JS_EXTENSIONS, ...TS_EXTENSIONS, ...PY_EXTENSIONS, ...RS_EXTENSIONS]);

class AccessError extends Error {}

const SUPPORTED_LIST = [...SOURCE_EXTENSIONS].join(", ");
// \\?\C:\x and \\?\UNC\server\share\x: Node 20/22 and Node 24 resolve these
// differently, so they are turned into plain paths first.
const WIN_NAMESPACE = /^[\\/]{2}\?[\\/](UNC[\\/])?/i;

function plainPath(requested, platform = process.platform) {
    if (/^file:/i.test(requested)) {
        try {
            return fileURLToPath(requested, { windows: platform === "win32" });
        } catch {
            throw new AccessError(`path must be a file path, not a URL: ${requested}`);
        }
    }
    if (platform === "win32") {
        const m = WIN_NAMESPACE.exec(requested);
        if (m) return (m[1] ? "\\\\" : "") + requested.slice(m[0].length);
    }
    return requested;
}

// The real path of the nearest existing ancestor plus the missing rest, so a
// path that does not exist is judged by where it would be.
function realOrNearest(absolute) {
    const rest = [];
    let dir = absolute;
    for (;;) {
        try {
            return path.join(fs.realpathSync(dir), ...[...rest].reverse());
        } catch {
            const parent = path.dirname(dir);
            if (parent === dir) return absolute;
            rest.push(path.basename(dir));
            dir = parent;
        }
    }
}

function outside(requested) {
    return new AccessError(`Access denied: ${requested} is outside the allowed folders`);
}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

// Allowed roots are canonical (realpath) directories. Anything that does not
// exist or is not a directory is dropped.
function canonicalRoots(dirs) {
    const out = [];
    for (const dir of dirs) {
        try {
            const real = fs.realpathSync(path.resolve(dir));
            if (fs.statSync(real).isDirectory() && !out.includes(real)) out.push(real);
        } catch {
            // ignore missing roots
        }
    }
    return out;
}

function rootsFromUris(roots) {
    const dirs = [];
    for (const root of roots || []) {
        if (typeof root?.uri !== "string" || !root.uri.startsWith("file:")) continue;
        try {
            dirs.push(fileURLToPath(root.uri));
        } catch {
            // ignore malformed URIs
        }
    }
    return canonicalRoots(dirs);
}

// Resolves a caller-supplied path against the allowed roots. Relative paths
// are taken relative to the first root. The real path (symlinks followed)
// must stay inside one of the roots.
function resolveInside(requested, roots) {
    if (!roots.length) {
        throw new AccessError(
            "No allowed folders are configured. Start the server with one or more folder " +
            "arguments, e.g. `npx -y sentinel-ir-mcp /path/to/project`, or use a client " +
            "that provides MCP roots."
        );
    }
    if (typeof requested !== "string" || requested.trim() === "" || requested.includes("\0")) {
        throw new AccessError("path must be a non-empty string");
    }
    const absolute = path.resolve(roots[0], plainPath(requested));
    let real;
    try {
        real = fs.realpathSync(absolute);
    } catch {
        // The same answer for a missing path outside the folders as for an
        // existing one, so the agent cannot probe what exists there. A
        // dangling symlink is refused too: its target may lie outside.
        let link = false;
        try { link = fs.lstatSync(absolute).isSymbolicLink(); } catch { /* missing */ }
        if (link || !roots.some((r) => isInside(realOrNearest(absolute), r))) throw outside(requested);
        throw new AccessError(`Not found: ${requested}`);
    }
    const root = roots.find((r) => isInside(real, r));
    if (!root) throw outside(requested);
    return { real, root, display: path.relative(root, real).split(path.sep).join("/") || "." };
}

function isSourceFile(file) {
    return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isJavaScriptFile(file) {
    return JS_EXTENSIONS.has(path.extname(file).toLowerCase());
}

module.exports = {
    AccessError,
    JS_EXTENSIONS,
    TS_EXTENSIONS,
    SOURCE_EXTENSIONS,
    SUPPORTED_LIST,
    canonicalRoots,
    plainPath,
    rootsFromUris,
    resolveInside,
    isInside,
    isJavaScriptFile,
    isSourceFile
};
