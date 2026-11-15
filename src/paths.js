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

function notUrl(requested) {
    return new AccessError(`Not a file path: ${requested} is a URL`);
}

function plainPath(requested, platform = process.platform) {
    if (/^file:/i.test(requested)) {
        if (!/^file:\/\//i.test(requested)) throw notUrl(requested);
        let url;
        try {
            url = new URL(requested);
        } catch {
            throw notUrl(requested);
        }
        // file://server/share is another machine; refused before any file
        // system call, because Windows would open an SMB connection to it.
        if (url.hostname && url.hostname.toLowerCase() !== "localhost") throw notUrl(requested);
        try {
            return fileURLToPath(requested, { windows: platform === "win32" });
        } catch {
            throw notUrl(requested);
        }
    }
    if (/^[a-z][a-z0-9+.-]+:\/\//i.test(requested) || /^(data|mailto|javascript|blob|about|tel|urn):/i.test(requested)) throw notUrl(requested);
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
            const real = plainPath(fs.realpathSync(path.resolve(plainPath(dir))));
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
    // A UNC path (\\server\share, \\.\UNC\...) outside every folder is refused
    // from its text alone: on Windows, realpath on it opens an SMB connection
    // to that server, which can leak NTLM credentials.
    if (/^[\\/]{2}/.test(absolute) && !roots.some((r) => isInside(absolute, r))) throw outside(requested);
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
