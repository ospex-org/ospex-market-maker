/**
 * Single-process lock for `state.dir` (DESIGN §12).
 *
 * The maker's persisted inventory under `state.dir` is **not multi-process safe**.
 * Two MM processes sharing one state directory — two `run` loops, or a `run` loop
 * plus a concurrent `cancel-stale` — last-writer-wins-corrupt `maker-state.json`
 * (gas counters, P&L, the signed-payload bundles, the `softCancelled` set). Worse,
 * the corrupted blob still passes the shallow load validation, so the boot-time
 * state-loss fail-safe never fires: the corruption is **silent**. DESIGN §12 and
 * `OPERATOR_SAFETY.md` have always documented "one MM per state directory" as an
 * operator rule; this module *enforces* it.
 *
 * Mechanism: an `O_EXCL` lock file at `state.dir/maker.lock`. The exclusive create
 * is the mutual-exclusion primitive — exactly one process can win the create. The
 * lock records the holder's identity (pid, hostname, maker wallet, config path, run
 * id) both for human diagnostics and for **stale-lock reclaim**: if the recorded
 * process is dead (same host, pid no longer exists) the lock is reclaimed; if it's
 * alive — or on a different host where liveness can't be checked, or the lock is
 * unparseable — acquisition **fails closed** with an operator-actionable message.
 *
 * Unlike `maker-state.json`, the lock file is **not** sensitive: it carries no
 * signing material, only a (public) wallet address, a hostname, and a local path.
 * It's still written `0o600` for tidiness and to avoid leaking the host's layout.
 *
 * PID-reuse note: after a hard crash a *different* live process can inherit the
 * dead holder's pid. The liveness probe would then report "alive" and we fail
 * closed — a conservative refusal (never a silent corruption), recoverable by the
 * operator removing the stale lock by hand once they've confirmed no MM is running.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

/** The lock file name inside `state.dir`. */
export const STATE_LOCK_FILE = 'maker.lock';

/** Bounded retries when reclaiming a stale lock another booting process races us to reclaim. */
const MAX_RECLAIM_ATTEMPTS = 3;

/**
 * Caller-supplied identity recorded in the lock — "who holds `state.dir`".
 * `maker` / `configPath` are best-effort (null when unresolved). The HIGH finding
 * (mm-review §1) asks the lock payload to carry maker / config / run identity so a
 * refused operator can see which instance already owns the directory.
 */
export interface StateLockIdentity {
  /** Best-effort maker wallet address (`0x…`), or null if it couldn't be resolved without unlocking the keystore. */
  maker: string | null;
  /** Path to the config file this process loaded, or null. */
  configPath: string | null;
  /** This process's telemetry run id. */
  runId: string;
  /** Which command + mode holds the lock, for diagnostics (e.g. `run --live`, `run --dry-run`, `cancel-stale`). */
  process: string;
}

/** The on-disk lock payload — the {@link StateLockIdentity} plus the runtime provenance used for stale-lock reclaim. */
interface LockFilePayload extends StateLockIdentity {
  /** Schema version of this lock file. */
  v: 1;
  /** OS process id of the holder — checked for liveness on a duplicate acquire (same host only). */
  pid: number;
  /** Host the holder runs on — a pid is only liveness-checkable on the same host. */
  hostname: string;
  /** When the lock was acquired (ISO-8601), for diagnostics. */
  acquiredAt: string;
}

/** A held lock. Call {@link release} on every process-exit path (idempotent). */
export interface StateLock {
  /** Path of the lock file (for diagnostics / tests). */
  readonly path: string;
  /**
   * Release the lock — removes the lock file **iff it's still ours** (same
   * pid + hostname + runId), so a lock another instance legitimately reclaimed
   * after us is never deleted. Idempotent and never throws (it runs on the
   * shutdown path).
   */
  release(): void;
}

/** Injectable seams so the lock can be unit-tested without real processes / hosts / clocks. */
export interface StateLockDeps {
  /** This process's pid. Default: `process.pid`. */
  pid?: number;
  /** This host's name. Default: `os.hostname()`. */
  hostname?: string;
  /** Is `pid` a live process *on this host*? Default: a `process.kill(pid, 0)` probe. */
  isProcessAlive?: (pid: number) => boolean;
  /** Wall clock for `acquiredAt`. Default: `() => new Date().toISOString()`. */
  now?: () => string;
}

/**
 * Thrown when the lock can't be acquired because the directory is (or may be) held
 * by another live MM process — a duplicate live holder, a holder on a different
 * host (liveness unverifiable), an unparseable lock, or persistent reclaim
 * contention. **Fail-closed**: the message names the conflicting holder and the
 * lock path so an operator can stop the other instance or, having confirmed it's
 * dead, remove the lock file by hand. The CLI converts this to its command-specific
 * "refused" error (printed verbatim, exit 1).
 */
export class StateLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateLockError';
  }
}

/** Default liveness probe: `process.kill(pid, 0)` performs the existence/permission check without delivering a signal. */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // no such process — the holder is gone
    // 'EPERM' = the process exists but is owned by another user → treat as alive.
    // Any other / unknown error → conservatively assume alive (fail closed).
    return true;
  }
}

type ReadLockResult = { ok: true; payload: LockFilePayload } | { ok: false; reason: string };

/**
 * Read + parse an existing lock file. Never throws — an unreadable / non-JSON /
 * structurally-invalid lock (no usable pid+hostname) is reported as `{ ok: false }`
 * so the caller can fail closed rather than crash. A lock with a valid pid+hostname
 * but missing soft identity fields still parses (the identity fields are advisory).
 */
function readLock(path: string): ReadLockResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `lock file unreadable: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'lock file is not valid JSON (possibly a partial write from a crashed acquire)' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'lock file is not an object' };
  const p = parsed as Record<string, unknown>;
  if (typeof p.pid !== 'number' || !Number.isInteger(p.pid) || p.pid <= 0) return { ok: false, reason: 'lock file has no valid pid' };
  if (typeof p.hostname !== 'string' || p.hostname.length === 0) return { ok: false, reason: 'lock file has no hostname' };
  const payload: LockFilePayload = {
    v: 1,
    pid: p.pid,
    hostname: p.hostname,
    acquiredAt: typeof p.acquiredAt === 'string' ? p.acquiredAt : '(unknown)',
    maker: typeof p.maker === 'string' ? p.maker : null,
    configPath: typeof p.configPath === 'string' ? p.configPath : null,
    runId: typeof p.runId === 'string' ? p.runId : '(unknown)',
    process: typeof p.process === 'string' ? p.process : '(unknown)',
  };
  return { ok: true, payload };
}

/** A one-line human description of the lock holder, for the fail-closed error messages. */
function describeHolder(h: LockFilePayload): string {
  return `pid ${h.pid} on ${h.hostname} — ${h.process}, maker ${h.maker ?? '(unknown)'}, run ${h.runId}, config ${h.configPath ?? '(unknown)'}, since ${h.acquiredAt}`;
}

/**
 * Acquire the single-process lock for `dir`, recording `identity`. Creates `dir`
 * if needed. Returns a {@link StateLock} whose `release()` removes the lock on
 * exit. Throws {@link StateLockError} (fail-closed) when another live MM holds the
 * directory; rethrows any other filesystem error (e.g. permission denied on the
 * directory) unchanged.
 */
export function acquireStateLock(dir: string, identity: StateLockIdentity, deps: StateLockDeps = {}): StateLock {
  const pid = deps.pid ?? process.pid;
  const host = deps.hostname ?? osHostname();
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const now = deps.now ?? ((): string => new Date().toISOString());

  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, STATE_LOCK_FILE);
  const payload: LockFilePayload = { v: 1, pid, hostname: host, acquiredAt: now(), ...identity };
  const body = `${JSON.stringify(payload, null, 2)}\n`;

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      // `flag: 'wx'` = O_WRONLY|O_CREAT|O_EXCL — the exclusive create IS the lock.
      // Cross-platform in Node (CREATE_NEW on Windows); `mode` is ignored there.
      writeFileSync(lockPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return makeLock(lockPath, pid, host, identity.runId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // a real fs error — surface it

      // The lock exists. Inspect the holder.
      const existing = readLock(lockPath);
      if (!existing.ok) {
        throw new StateLockError(
          `refusing to start: a lock file at ${lockPath} exists but couldn't be read (${existing.reason}). ` +
            `Another MM may be running against this state.dir, or a prior run left a corrupt lock. ` +
            `If you've confirmed no MM is running against this directory, remove ${lockPath} by hand and retry (DESIGN §12 — one MM per state.dir).`,
        );
      }
      const holder = existing.payload;
      if (holder.hostname !== host) {
        throw new StateLockError(
          `refusing to start: state.dir is locked by a process on a different host (${describeHolder(holder)}). ` +
            `This MM can't verify whether that process is still alive, and sharing one state.dir across hosts is unsupported (DESIGN §12). ` +
            `Point this instance at its own state.dir, or — if that host is down — remove ${lockPath} by hand and retry.`,
        );
      }
      if (isAlive(holder.pid)) {
        throw new StateLockError(
          `refusing to start: an MM is already running against this state.dir (${describeHolder(holder)}). ` +
            `Only one MM may use a state.dir at a time — its JSON state is not multi-process safe (DESIGN §12). ` +
            `Stop that instance first, or point this one at a different state.dir. (Lock: ${lockPath}.)`,
        );
      }

      // Stale lock — the recorded process is dead on this host. Reclaim it: unlink,
      // then retry the exclusive create. If another booting process reclaims first,
      // our retry's EEXIST re-reads a FRESH (live) lock and we fail closed above.
      try {
        unlinkSync(lockPath);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
    }
  }

  throw new StateLockError(
    `refusing to start: could not acquire the state.dir lock at ${lockPath} after ${MAX_RECLAIM_ATTEMPTS} attempts — ` +
      `another process keeps re-acquiring it as this one reclaims a stale lock. Ensure exactly one MM targets this state.dir.`,
  );
}

/** Build the {@link StateLock} handle returned on a successful acquire. */
function makeLock(lockPath: string, pid: number, host: string, runId: string): StateLock {
  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      // Remove the lock only if it's still OURS — a different instance may have
      // legitimately reclaimed it (e.g. if this process was wrongly judged dead).
      const current = readLock(lockPath);
      if (current.ok && current.payload.pid === pid && current.payload.hostname === host && current.payload.runId === runId) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Best-effort — release must not throw on the shutdown path.
        }
      }
      // else: not ours / already gone — leave it.
    },
  };
}
