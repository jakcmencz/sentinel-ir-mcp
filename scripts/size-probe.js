"use strict";

// Informational: time and peak memory of analyzing large valid JavaScript
// with the installed sentinel-ir, to check the --max-file-bytes ceiling on
// this OS. Each size runs in its own process; writes compat-size.json.
const fs = require("fs");
const { spawnSync } = require("child_process");

if (process.argv[2] === "--child") {
    const { analyzeAsync } = require("sentinel-ir");
    const bytes = Number(process.argv[3]);
    const unit = (i) => `function f${i}(a){ const x = require('fs'); if(a){ return x.readFileSync(a+'${i}'); } return [1,2,3].map(y=>y*${i}); }\n`;
    const parts = [];
    let size = 0;
    for (let i = 0; size < bytes; i++) { const u = unit(i); parts.push(u); size += u.length; }
    const start = Date.now();
    analyzeAsync(parts.join("")).then((ir) => {
        process.stdout.write(JSON.stringify({ bytes: size, ms: Date.now() - start, status: ir.analysisStatus, rssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));
    });
} else {
    const results = [];
    for (const mib of [1, 2, 4]) {
        const r = spawnSync(process.execPath, [__filename, "--child", String(mib * 1024 * 1024)], { encoding: "utf8", timeout: 300000 });
        let row;
        try { row = JSON.parse(r.stdout); } catch { row = { error: `exit ${r.status} ${r.signal || ""}`.trim() }; }
        results.push({ mib, ...row });
        console.log(JSON.stringify({ mib, ...row }));
    }
    fs.writeFileSync("compat-size.json", JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
}
