"use strict";

const fs = require("fs");
const path = require("path");

// Exclusions are set by the user when the server starts (--exclude), never by
// the analyzed project: a repository could otherwise hide its own files.
//
//   secrets        a file or folder with this name anywhere
//   config/prod.js this path, relative to the allowed folder
//   *.min.js       * and ? match within a name, ** across folders
//
// A matching folder excludes everything inside it. There is no negation.

const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 256;
// Characters cmd.exe acts on: an MCP entry on Windows runs through "cmd /c".
const UNSAFE = /["&|<>^%!\u0000-\u001f]/;

class ExcludeError extends Error {}

function normalizePattern(raw) {
    if (typeof raw !== "string") throw new ExcludeError("an exclusion must be text");
    let p = raw.trim().normalize("NFC").replace(/\\/g, "/");
    if (p === "") throw new ExcludeError("an exclusion is empty");
    if (p.length > MAX_PATTERN_LENGTH) throw new ExcludeError(`an exclusion is longer than ${MAX_PATTERN_LENGTH} characters`);
    if (UNSAFE.test(p)) throw new ExcludeError(`exclusion "${raw}" contains a character that is not allowed (" & | < > ^ % !)`);
    if (p.startsWith("/") || /^[a-z]:/i.test(p)) {
        throw new ExcludeError(`exclusion "${raw}" must be relative to the project folder, e.g. "dist" or "src/generated"`);
    }
    while (p.startsWith("./")) p = p.slice(2);
    p = p.replace(/\/+/g, "/").replace(/\/$/, "");
    const parts = p.split("/");
    if (p === "" || p === "." || parts.some((s) => s === "." || s === "..")) {
        throw new ExcludeError(`exclusion "${raw}" must name files or folders inside the project, without "." or ".."`);
    }
    return p;
}

function segmentRegex(segment) {
    return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
}

function patternRegex(pattern, caseInsensitive) {
    const parts = pattern.split("/");
    let body = "";
    parts.forEach((part, i) => {
        const last = i === parts.length - 1;
        if (part === "**") body += last ? ".*" : "(?:[^/]+/)*";
        else body += segmentRegex(part) + (last ? "" : "/");
    });
    const anchor = parts.length === 1 && parts[0] !== "**" ? "(?:^|/)" : "^";
    return new RegExp(`${anchor}${body}(?:/|$)`, caseInsensitive ? "iu" : "u");
}

// Windows and macOS file names ignore case by default, so SECRETS/x.js must
// not get past "secrets".
function defaultCaseInsensitive(platform = process.platform) {
    return platform === "win32" || platform === "darwin";
}

function createExcluder(patterns = [], { caseInsensitive = defaultCaseInsensitive() } = {}) {
    if (patterns.length > MAX_PATTERNS) throw new ExcludeError(`at most ${MAX_PATTERNS} exclusions`);
    const list = [...new Set(patterns.map(normalizePattern))];
    const regexes = list.map((p) => patternRegex(p, caseInsensitive));
    // rel: a path relative to an allowed folder; "" or "." is the folder itself.
    const matches = (rel) => {
        if (!regexes.length) return false;
        const r = String(rel).normalize("NFC").split(path.sep).join("/").replace(/\\/g, "/");
        if (r === "" || r === ".") return false;
        return regexes.some((re) => re.test(r));
    };
    return { patterns: list, active: list.length > 0, matches };
}

const NONE = createExcluder([]);

function nativeReal(p) {
    try { return fs.realpathSync.native(p); } catch { return p; }
}

function relativeIn(file, root) {
    const rel = path.relative(root, file);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? rel : null;
}

// True if `file` is excluded below any allowed root. Checked on the path as
// given and on the native real path, which on Windows expands 8.3 short names
// (SECRE~1) and on Windows and macOS returns the real letter case.
function isExcluded(file, roots, excluder) {
    if (!excluder || !excluder.active) return false;
    const candidates = [path.resolve(file), nativeReal(path.resolve(file))];
    for (const root of roots) {
        for (const base of [root, nativeReal(root)]) {
            for (const c of candidates) {
                const rel = relativeIn(c, base);
                if (rel !== null && excluder.matches(rel)) return true;
            }
        }
    }
    return false;
}

// Counts what the exclusions skip, for doctor. Same walk rules as
// analyze_directory; stops after `limit` entries.
function countExcluded(root, excluder, { skipDirs = new Set(), limit = 20000 } = {}) {
    const result = { excluded: 0, examples: [], complete: true };
    if (!excluder.active) return result;
    const queue = [root];
    let seen = 0;
    while (queue.length) {
        const dir = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (++seen > limit) { result.complete = false; return result; }
            const full = path.join(dir, e.name);
            const rel = path.relative(root, full).split(path.sep).join("/");
            if (e.isSymbolicLink()) continue;
            if (excluder.matches(rel)) {
                result.excluded++;
                if (result.examples.length < 5) result.examples.push(rel + (e.isDirectory() ? "/" : ""));
            } else if (e.isDirectory() && !skipDirs.has(e.name) && !e.name.startsWith(".")) {
                queue.push(full);
            }
        }
    }
    return result;
}

module.exports = { ExcludeError, MAX_PATTERNS, normalizePattern, createExcluder, defaultCaseInsensitive, isExcluded, countExcluded, NONE };
