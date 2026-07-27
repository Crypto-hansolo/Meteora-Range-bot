#!/usr/bin/env node
/**
 * Run the test suite.
 *
 * `node --test "test/*.test.ts"` only works on Node 22+, which expands the glob
 * itself. On Node 20 the pattern reaches Node verbatim and it gives up, and
 * dropping the quotes to let the shell expand instead breaks on Windows, where
 * npm runs scripts through cmd. Node 20's own directory discovery does not help
 * either: it only looks for `.js` files, so a directory argument finds nothing
 * here.
 *
 * Listing the files ourselves sidesteps all three problems.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "test";

let files;
try {
  files = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(TEST_DIR, name));
} catch (error) {
  console.error(`Cannot read ${TEST_DIR}/: ${String(error)}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No *.test.ts files in ${TEST_DIR}/`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "--import", "tsx", ...files, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
