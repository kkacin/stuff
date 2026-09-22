// Runs every mod test in a fresh process, since each one installs its own
// mock ModAPI onto the global object.
"use strict";
const { execFileSync } = require("child_process");
const path = require("path");

const suites = ["spidermod.test.js", "smartzombies.test.js", "lavaskeletons.test.js", "acidrain.test.js"];
let failed = 0;

for (const suite of suites) {
  console.log("\n=== " + suite + " ===");
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, suite)], { encoding: "utf8" }));
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    failed++;
  }
}

console.log(failed ? "\n" + failed + " suite(s) failed" : "\nall suites passed");
process.exit(failed ? 1 : 0);
