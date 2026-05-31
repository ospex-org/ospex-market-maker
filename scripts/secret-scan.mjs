// Secret scanner — fails CI on accidentally-committed EIP-712 signing material
// (own-state SSE plan §M6/B).
//
// Post-M6/A, the MM persists the SDK's canonical SignedCommitmentPayload in
// `state.dir/maker-state.json` so cancel paths can authoritatively cancel
// book-hidden rows without round-tripping the public commitments API (which
// redacts the signed payload for hidden rows). Anything an adversary needs to
// fill the maker's commitments — the 65-byte ECDSA signature, the EIP-712
// typed-data fields paired with that signature — must NEVER reach the public
// tree (issues, PRs, docs, log excerpts, debug dumps). This scanner runs in CI
// on every PR so a leak surfaces before merge.
//
// What it looks for, on every line of every tracked text file:
//   1. A 65-byte ECDSA signature: 0x-prefixed 130 hex chars. There is no
//      legitimate reason for that pattern to appear in this repo (synthetic
//      test fixtures use short stubs like '0xdead', not full-length).
//   2. A JSON-shaped signed-payload leak: a `"signedPayload":` line, or a
//      `"signature": "0x...` line. Either is a strong signal that someone
//      pasted state.json / a structured log excerpt into a tracked file.
//
// On any hit: print file:line:col, the matched pattern's purpose, a remediation
// hint, and exit 1.
//
// What it does NOT do: scan binary files, archived tarballs, node_modules, dist,
// .git, or anything ignored by .gitignore (we drive off `git ls-files`). The
// canonical state directory under `state.dir` is `.gitignore`d by default
// (developers running the MM locally — the scanner protects against the human
// mistake of pasting state contents into a tracked doc).
//
// Run: `yarn secret-scan` (locally) or via the CI job that calls this script.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

// The 130-hex signature regex is built from a string template so the literal
// pattern never appears as a contiguous regex in this file's source — running
// the scanner against this script must NOT match the script itself. The double
// quote and brace prevent accidental self-match.
const HEX_CHAR = '[0-9a-fA-F]';
const ECDSA_SIG_PATTERN = new RegExp(`0x${HEX_CHAR}{130}\\b`);

// Two structural patterns for JSON-shaped leaks. They DON'T require the
// signature regex on the same line — a pretty-printed state file puts the
// signature on its own line below the key.
const SIGNED_PAYLOAD_KEY = /"signedPayload"\s*:/;
const SIGNATURE_KEY_WITH_HEX = /"signature"\s*:\s*"0x/;

// This scanner itself names the patterns. Skip the scanner so a literal
// description doesn't self-match the structural patterns.
const SELF_PATH_SUFFIX = 'scripts/secret-scan.mjs';

const FINDINGS = [];

function listTrackedFiles() {
  try {
    // `--cached` lists files in the index (tracked); `--others
    // --exclude-standard` adds untracked-but-not-gitignored files. Together
    // this catches a new file a developer just created locally — the most
    // common form of pre-commit leak. CI will see the same files via the
    // checkout, but with untracked turned into tracked.
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', cwd: process.cwd() });
    return out.split('\n').filter((p) => p.length > 0);
  } catch (err) {
    console.error(`secret-scan: \`git ls-files\` failed: ${err.message}`);
    console.error('secret-scan: this scanner is designed for use in a git working tree (CI / local PR check).');
    process.exit(2);
  }
}

function isProbablyBinary(buf) {
  // The same heuristic git uses: look for a NUL byte in the first 8 KiB.
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) if (buf[i] === 0) return true;
  return false;
}

function recordFinding(file, lineNo, col, line, kind, hint) {
  FINDINGS.push({ file, lineNo, col, kind, snippet: line.slice(Math.max(0, col - 1), col + 80), hint });
}

function scanFile(file) {
  // Skip the scanner itself — it names the patterns it looks for.
  if (file.endsWith(SELF_PATH_SUFFIX) || file === SELF_PATH_SUFFIX) return;

  // Skip files larger than 5 MiB (oversized binary blobs / lockfiles). The
  // scanner's job is text content; a 50 MB tarball isn't where a leak hides.
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return; // file vanished between ls-files and stat — nothing to scan
  }
  if (stat.size > 5 * 1024 * 1024) return;

  const buf = readFileSync(file);
  if (isProbablyBinary(buf)) return;
  const text = buf.toString('utf8');

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const sigMatch = line.match(ECDSA_SIG_PATTERN);
    if (sigMatch !== null && sigMatch.index !== undefined) {
      recordFinding(file, i + 1, sigMatch.index + 1, line, 'ECDSA_SIGNATURE',
        'A 65-byte 0x-prefixed hex string is the shape of an EIP-712 signature. Replace with a short synthetic stub like "0xdead" if this is a test fixture, or remove the line entirely if it leaked from a real state dump.');
    }
    const payloadMatch = line.match(SIGNED_PAYLOAD_KEY);
    if (payloadMatch !== null && payloadMatch.index !== undefined) {
      recordFinding(file, i + 1, payloadMatch.index + 1, line, 'SIGNED_PAYLOAD_KEY',
        '"signedPayload": appears to be a leaked persisted-state field. State files belong under .gitignored state.dir, not in tracked sources/docs. Move to .gitignore or redact.');
    }
    const sigKeyMatch = line.match(SIGNATURE_KEY_WITH_HEX);
    if (sigKeyMatch !== null && sigKeyMatch.index !== undefined) {
      recordFinding(file, i + 1, sigKeyMatch.index + 1, line, 'SIGNATURE_KEY_WITH_HEX',
        '"signature": "0x..." appears to be a leaked EIP-712 signature field. Move to .gitignored state.dir, replace with a short synthetic stub for tests, or redact.');
    }
  }
}

function main() {
  const files = listTrackedFiles();
  for (const file of files) scanFile(file);

  if (FINDINGS.length === 0) {
    console.log(`secret-scan: ok (scanned ${files.length} tracked files)`);
    return;
  }

  console.error(`secret-scan: FOUND ${FINDINGS.length} potential signing-material leak(s):\n`);
  for (const f of FINDINGS) {
    console.error(`  ${f.file}:${f.lineNo}:${f.col}  [${f.kind}]`);
    console.error(`    > ${f.snippet}`);
    console.error(`    hint: ${f.hint}`);
    console.error('');
  }
  console.error('See own-state SSE plan §M6/B for the redaction rules. If a finding is a false positive');
  console.error('(e.g. a synthetic test vector that happens to be 130 hex chars), refactor it shorter or');
  console.error('split the literal so the regex no longer matches a contiguous run.');
  process.exit(1);
}

main();
