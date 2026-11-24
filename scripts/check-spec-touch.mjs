#!/usr/bin/env node
/**
 * Non-blocking living-spec reminder (inspired by neutree-ai/ui check-contract-touch):
 * Warns when core protocol/PTY/relay behavior files change without touching docs/SPEC.md.
 * Inspects local uncommitted git status first, and falls back to PR/HEAD commit diff in CI.
 * Always exits 0 so exploratory/refactoring commits are never artificially blocked.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CORE_WATCH_PATHS = [
  "packages/shared/src/index.ts",
  "crates/rift/src/protocol.rs",
  "crates/rift/src/console.rs",
  "crates/rift/src/proxy.rs",
  "crates/rift/src/setup.rs",
  "packages/relay/src/index.ts",
];

function git(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function getChangedFiles() {
  try {
    const status = git("git status --porcelain")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const raw = line.slice(3).trim();
        const target = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
        return target.replace(/^"|"$/g, "");
      });
    if (status.length > 0) return status;

    // Clean working tree (e.g. GitHub Actions CI): inspect PR base or HEAD~1..HEAD
    const baseRef = process.env.GITHUB_BASE_REF;
    if (baseRef) {
      try {
        return git(`git diff --name-only origin/${baseRef}...HEAD`).split(/\r?\n/).filter(Boolean);
      } catch {}
    }
    return git("git diff --name-only HEAD~1..HEAD").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

const changed = getChangedFiles();
const touchedCore = changed.filter((f) => CORE_WATCH_PATHS.includes(f));
const touchedSpec = changed.some((f) => f === "docs/SPEC.md");

if (touchedCore.length > 0 && !touchedSpec) {
  console.warn(
    `[check:spec] WARN: Core behavior/protocol files changed (${touchedCore.join(", ")}) without updating docs/SPEC.md.`
  );
  console.warn(
    `[check:spec] Reminder: if this changes a red line, protocol invariant, or verified boundary, update docs/SPEC.md in the same change.`
  );
} else {
  console.log("[check:spec] OK");
}
