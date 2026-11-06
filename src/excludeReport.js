"use strict";

const { createExcluder, countExcluded } = require("./exclude");

// Human-readable lines about what the exclusions skip in the given folders,
// for setup and doctor. A pattern that skips nothing is often a typo.
function describeExcluded(patterns, folders, skipDirs) {
    if (!patterns.length) return ["Excluded: nothing (the agent may analyze every source file in the folder)"];
    const lines = [`Excluded: ${patterns.join(", ")} (set by you; the agent cannot change it)`];
    for (const folder of folders) {
        const all = countExcluded(folder, createExcluder(patterns), { skipDirs });
        const more = all.complete ? "" : " or more (stopped counting)";
        const sample = all.examples.length ? `, e.g. ${all.examples.join(", ")}` : "";
        lines.push(`  in ${folder}: ${all.excluded}${more} file(s) or folder(s) excluded right now${sample}`);
        if (!all.complete) continue;
        const unused = patterns.filter((p) => countExcluded(folder, createExcluder([p]), { skipDirs }).excluded === 0);
        if (unused.length) lines.push(`  matches nothing there yet (typo?): ${unused.join(", ")}`);
    }
    return lines;
}

module.exports = { describeExcluded };
