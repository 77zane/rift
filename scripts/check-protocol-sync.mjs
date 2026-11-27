#!/usr/bin/env node
/**
 * Deterministic static gate: verifies TypeScript (@rift/shared) and Rust (crates/rift)
 * wire protocol definitions stay in sync:
 *   1. Binary frame constants (FRAME_PTY_OUTPUT, FRAME_PTY_INPUT, FRAME_PTY_REPLAY)
 *   2. SessionInfo & HostGroup fields (camelCase)
 *   3. Every ControlMessage `type` variant AND its per-variant field names
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

function extractBalancedBlock(src, startIdx) {
  let depth = 0;
  let openIdx = -1;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === "{") {
      if (depth === 0) openIdx = i;
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0 && openIdx >= 0) {
        return { body: src.slice(openIdx + 1, i), endIdx: i + 1 };
      }
    }
  }
  return null;
}

/**
 * @param {string} [rootDir]
 * @returns {{ ok: boolean, failures: string[], summary: string }}
 */
export function checkProtocolSync(rootDir = ROOT) {
  const tsPath = path.join(rootDir, "packages/shared/src/index.ts");
  const rsPath = path.join(rootDir, "crates/rift/src/protocol.rs");
  const tsSrc = fs.readFileSync(tsPath, "utf8");
  const rsSrc = fs.readFileSync(rsPath, "utf8");

  const failures = [];
  const fail = (msg) => failures.push(msg);

  // 1. Frame constants
  const tsFrames = new Map();
  for (const m of tsSrc.matchAll(/export const (FRAME_PTY_\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/g)) {
    tsFrames.set(m[1], Number(m[2]));
  }
  const rsFrames = new Map();
  for (const m of rsSrc.matchAll(/pub const (FRAME_PTY_\w+)\s*:\s*u8\s*=\s*(0x[0-9a-fA-F]+|\d+)/g)) {
    rsFrames.set(m[1], Number(m[2]));
  }
  if (tsFrames.size === 0 || rsFrames.size === 0) {
    fail(`Failed to parse FRAME_PTY_* constants (TS=${tsFrames.size}, Rust=${rsFrames.size})`);
  }
  for (const [k, v] of tsFrames) {
    if (!rsFrames.has(k) || rsFrames.get(k) !== v) {
      fail(`Frame constant mismatch for ${k}: TS=${v}, Rust=${rsFrames.get(k)}`);
    }
  }
  for (const k of rsFrames.keys()) {
    if (!tsFrames.has(k)) {
      fail(`Frame constant ${k} exists in Rust but not TS`);
    }
  }

  // 2. Shared structs: SessionInfo and HostGroup
  function checkStructSync(name) {
    const tsMatch = tsSrc.match(new RegExp(`export interface ${name}\\s*\\{`));
    const rsMatch = rsSrc.match(new RegExp(`pub struct ${name}\\s*\\{`));
    if (!tsMatch || !rsMatch) {
      fail(`Could not locate ${name} in both TS and Rust`);
      return 0;
    }
    const tsBody = extractBalancedBlock(tsSrc, tsMatch.index)?.body ?? "";
    const rsBody = extractBalancedBlock(rsSrc, rsMatch.index)?.body ?? "";

    const tsFields = new Set([...tsBody.matchAll(/^\s+(\w+)\??\s*:/gm)].map((m) => m[1]));
    const rsFields = new Set([...rsBody.matchAll(/^\s+pub\s+(\w+)\s*:/gm)].map((m) => snakeToCamel(m[1])));

    if (tsFields.size === 0 || rsFields.size === 0) {
      fail(`Parsed 0 fields for ${name} (TS=${tsFields.size}, Rust=${rsFields.size})`);
      return 0;
    }
    for (const f of tsFields) {
      if (!rsFields.has(f)) fail(`${name}.${f} is in TS (@rift/shared) but missing in Rust (protocol.rs)`);
    }
    for (const f of rsFields) {
      if (!tsFields.has(f)) fail(`${name}.${f} is in Rust (protocol.rs) but missing in TS (@rift/shared)`);
    }
    return tsFields.size;
  }

  const sessionFieldCount = checkStructSync("SessionInfo");
  const hostFieldCount = checkStructSync("HostGroup");

  // 3. ControlMessage variants AND per-variant fields
  const tsCtrlMatch = tsSrc.match(/export type ControlMessage\s*=/);
  const tsVariants = new Map();
  if (!tsCtrlMatch) {
    fail("Could not locate `export type ControlMessage` in packages/shared/src/index.ts");
  } else {
    let pos = tsCtrlMatch.index + tsCtrlMatch[0].length;
    while (pos < tsSrc.length) {
      const ch = tsSrc[pos];
      if (ch === ";") break;
      if (ch === "{") {
        const block = extractBalancedBlock(tsSrc, pos);
        if (!block) break;
        const typeMatch = block.body.match(/type:\s*"([^"]+)"/);
        if (typeMatch) {
          const fields = new Set(
            [...block.body.matchAll(/^\s+(\w+)\??\s*:/gm)]
              .map((m) => m[1])
              .filter((f) => f !== "type")
          );
          tsVariants.set(typeMatch[1], fields);
        }
        pos = block.endIdx;
        continue;
      }
      pos++;
    }
  }

  const rsEnumMatch = rsSrc.match(/pub enum ControlMessage\s*\{/);
  const rsVariants = new Map();
  if (!rsEnumMatch) {
    fail("Could not locate `pub enum ControlMessage` in crates/rift/src/protocol.rs");
  } else {
    const rsEnumBody = extractBalancedBlock(rsSrc, rsEnumMatch.index)?.body ?? "";
    const attrRe = /#\[serde\(rename\s*=\s*"([^"]+)"[^\]]*\)\]/g;
    let m;
    while ((m = attrRe.exec(rsEnumBody)) !== null) {
      const variantType = m[1];
      const braceIdx = rsEnumBody.indexOf("{", m.index + m[0].length);
      const block = braceIdx >= 0 ? extractBalancedBlock(rsEnumBody, braceIdx) : null;
      if (!block) {
        fail(`Could not parse Rust enum variant body for "${variantType}"`);
        continue;
      }
      // Strip serde attributes like #[serde(...)] before matching `field_name: Type`
      const cleaned = block.body.replace(/#\[[^\]]*\]/g, "");
      const fields = new Set(
        [...cleaned.matchAll(/(\w+)\s*:/g)].map((fm) => snakeToCamel(fm[1]))
      );
      rsVariants.set(variantType, fields);
    }
  }

  if (tsVariants.size === 0 || rsVariants.size === 0) {
    fail(`Parsed 0 ControlMessage variants (TS=${tsVariants.size}, Rust=${rsVariants.size})`);
  }

  for (const [typeName, tsFields] of tsVariants) {
    if (!rsVariants.has(typeName)) {
      fail(`ControlMessage "${typeName}" is in TS (@rift/shared) but missing in Rust (protocol.rs)`);
      continue;
    }
    const rsFields = rsVariants.get(typeName);
    for (const f of tsFields) {
      if (!rsFields.has(f)) {
        fail(`ControlMessage "${typeName}" field "${f}" is in TS but missing in Rust`);
      }
    }
    for (const f of rsFields) {
      if (!tsFields.has(f)) {
        fail(`ControlMessage "${typeName}" field "${f}" is in Rust but missing in TS`);
      }
    }
  }
  for (const typeName of rsVariants.keys()) {
    if (!tsVariants.has(typeName)) {
      fail(`ControlMessage "${typeName}" is in Rust (protocol.rs) but missing in TS (@rift/shared)`);
    }
  }

  const summary = `${tsFrames.size} frame constants, ${tsVariants.size} ControlMessage variants + fields, ${sessionFieldCount} SessionInfo + ${hostFieldCount} HostGroup fields synced`;
  return { ok: failures.length === 0, failures, summary };
}

function isCliEntry(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
  }
}

if (isCliEntry(import.meta.url)) {
  const { ok, failures, summary } = checkProtocolSync();
  if (!ok) {
    for (const msg of failures) console.error(`[check:protocol] FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`[check:protocol] OK (${summary})`);
}
