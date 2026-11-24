"use strict";

const fs = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const { PACKAGE_SPEC } = require("./clients");

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
// macOS file systems are usually case-insensitive and the JS realpath keeps the
// letter case it was given, so /Users/a/Proj and /users/a/proj would not match;
// the native one returns the case stored on disk. Elsewhere the JS one stays:
// on Windows the native one expands 8.3 short names differently.
const realpath = (p) => (process.platform === "darwin" ? fs.realpathSync.native(p) : fs.realpathSync(p));

function realOrNearest(absolute) {
    const rest = [];
    let dir = absolute;
    for (;;) {
        try {
            return path.join(realpath(dir), ...[...rest].reverse());
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
            const real = plainPath(realpath(path.resolve(plainPath(dir))));
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

// The allowed folders in which a relative path exists with its real path
// inside the allowed folders. A candidate outside (../x, a symlink out) is
// skipped whether it exists or not, so the answer does not tell the agent
// what exists outside.
function candidateRoots(requested, roots) {
    const found = [];
    if (roots.length > 1 && !path.isAbsolute(requested)) {
        for (const r of roots) {
            let real;
            try { real = realpath(path.resolve(r, requested)); } catch { continue; }
            if (roots.some((root) => isInside(real, root))) found.push({ root: r, real });
        }
    }
    return found;
}

// The folder a relative path is taken from: the first allowed folder in which
// it exists (see candidateRoots), else the first in which the name itself is
// there (a symlink pointing out or nowhere, refused below), else the first one.
function baseRoot(requested, roots) {
    if (roots.length > 1 && !path.isAbsolute(requested)) {
        const [first] = candidateRoots(requested, roots);
        if (first) return first.root;
        for (const r of roots) {
            const at = path.resolve(r, requested);
            if (!isInside(at, r)) continue;
            try { fs.lstatSync(at); return r; } catch { /* not here */ }
        }
    }
    return roots[0];
}

// Whether the symlink at absolute loops while every link on the way stays
// inside the allowed folders; a chain that leaves them is not followed.
function loopsInside(absolute, roots) {
    const seen = new Set();
    let p = absolute;
    for (let hops = 0; hops < 64; hops++) {
        const at = path.join(realOrNearest(path.dirname(p)), path.basename(p));
        if (!roots.some((r) => isInside(at, r))) return false;
        if (seen.has(at)) return true;
        seen.add(at);
        let target;
        try { target = fs.readlinkSync(at); } catch { return false; }
        p = path.resolve(path.dirname(at), target);
    }
    return false;
}

// The path itself or a folder on the way to it (dA/x.js) is a symlink that
// loops inside the allowed folders.
function loopingLink(absolute, roots) {
    for (let p = absolute; roots.some((r) => isInside(p, r)); p = path.dirname(p)) {
        let link = false;
        try { link = fs.lstatSync(p).isSymbolicLink(); } catch { /* not there or looping above */ }
        if (link) return loopsInside(p, roots);
        if (path.dirname(p) === p) break;
    }
    return false;
}

// Resolves a caller-supplied path against the allowed roots (relative paths:
// see baseRoot). The real path (symlinks followed) must stay inside one of the roots.
function resolveInside(requested, roots) {
    if (!roots.length) {
        throw new AccessError(
            "No allowed folders are configured. Start the server with one or more folder " +
            `arguments, e.g. \`npx -y ${PACKAGE_SPEC} /path/to/project\`, or use a client ` +
            "that provides MCP roots."
        );
    }
    if (typeof requested !== "string" || requested.trim() === "") {
        throw new AccessError("path must be a non-empty string");
    }
    if (requested.includes("\0")) throw new AccessError("path must not contain a NUL character");
    const plain = plainPath(requested);
    const absolute = path.resolve(baseRoot(plain, roots), plain);
    // A UNC path (\\server\share, \\.\UNC\...) outside every folder is refused
    // from its text alone: on Windows, realpath on it opens an SMB connection
    // to that server, which can leak NTLM credentials.
    if (/^[\\/]{2}/.test(absolute) && !roots.some((r) => isInside(absolute, r))) throw outside(requested);
    let real;
    try {
        real = realpath(absolute);
    } catch (e) {
        // The same answer for a missing path outside the folders as for an
        // existing one, so the agent cannot probe what exists there. A
        // dangling symlink is refused too: its target may lie outside.
        let link = false;
        try { link = fs.lstatSync(absolute).isSymbolicLink(); } catch { /* missing */ }
        // A symlink loop inside the folders is named; where it points is not followed.
        if (e.code === "ELOOP" && loopingLink(absolute, roots)) {
            throw new AccessError(`Access denied: ${requested} is a symlink loop`);
        }
        if (link || !roots.some((r) => isInside(realOrNearest(absolute), r))) throw outside(requested);
        throw new AccessError(`Not found: ${requested}`);
    }
    const root = roots.find((r) => isInside(real, r));
    if (!root) throw outside(requested);
    // With several folders a path relative to one of them is ambiguous, so
    // results name the full path.
    const display = roots.length > 1 ? real : path.relative(root, real).split(path.sep).join("/") || ".";
    return { real, root, display };
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
    baseRoot,
    candidateRoots,
    realpath,
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
