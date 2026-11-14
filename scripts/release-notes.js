"use strict";
// Prints the README section of one version ("**X.Y.Z** ...") as GitHub
// release notes. Glama lists a new version only from a GitHub release.
const fs = require("fs");
const path = require("path");

const VERSION_LINE = /^\*\*\d+\.\d+\.\d+\*\*/;

function releaseNotes(readme, version) {
    const lines = readme.split(/\r?\n/);
    const start = lines.findIndex((l) => l.startsWith(`**${version}**`));
    if (start < 0) return null;
    let end = start + 1;
    while (end < lines.length && !VERSION_LINE.test(lines[end]) && !lines[end].startsWith("## ")) end++;
    const body = lines.slice(start, end).join("\n").trim();
    return `${body}\n\nnpm: https://www.npmjs.com/package/sentinel-ir-mcp/v/${version}\n` +
        "Canonical repository: https://gitlab.com/jakubrojicek11/sentinel-ir-mcp\n";
}

if (require.main === module) {
    const version = String(process.argv[2] || "").replace(/^v/, "");
    const readme = fs.readFileSync(process.argv[3] || path.join(__dirname, "..", "README.md"), "utf8");
    const notes = releaseNotes(readme, version);
    if (!notes) {
        console.error(`README.md has no "**${version}**" section`);
        process.exit(1);
    }
    process.stdout.write(notes);
}

module.exports = { releaseNotes };
