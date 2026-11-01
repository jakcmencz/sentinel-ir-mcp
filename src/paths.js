"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");

const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);
const PY_EXTENSIONS = new Set([".py", ".pyi"]);
const SOURCE_EXTENSIONS = new Set([...JS_EXTENSIONS, ...TS_EXTENSIONS, ...PY_EXTENSIONS]);

class AccessError extends Error {}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
    const absolute = path.resolve(roots[0], requested);
    let real;
    try {
        real = fs.realpathSync(absolute);
    } catch {
        throw new AccessError(`Not found: ${requested}`);
    }
    const root = roots.find((r) => isInside(real, r));
    if (!root) {
        throw new AccessError(`Access denied: ${requested} is outside the allowed folders`);
    }
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
    canonicalRoots,
    rootsFromUris,
    resolveInside,
    isInside,
    isJavaScriptFile,
    isSourceFile
};
