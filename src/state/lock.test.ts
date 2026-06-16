import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

import { acquireStateLock, STATE_LOCK_FILE, StateLockError, type StateLockDeps, type StateLockIdentity } from './lock.js';

// ── harness ──────────────────────────────────────────────────────────────────

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ospex-mm-lock-'));
  lockPath = join(dir, STATE_LOCK_FILE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const IDENTITY: StateLockIdentity = {
  maker: '0xabc0000000000000000000000000000000000abc',
  configPath: '/etc/ospex-mm.yaml',
  runId: 'run-1',
  process: 'run --live',
};

/** Deterministic deps: a fixed pid/hostname/clock and an explicit liveness verdict. */
function deps(overrides: Partial<StateLockDeps> = {}): StateLockDeps {
  return { pid: 4242, hostname: 'host-a', isProcessAlive: () => true, now: () => '2026-06-15T00:00:00.000Z', ...overrides };
}

/** Read + parse the on-disk lock file. */
function readLockFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
}

/** Pre-seed an existing lock file (simulating a prior/other holder). */
function seedLock(payload: Record<string, unknown>): void {
  writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

// ── acquire — happy path ──────────────────────────────────────────────────────

describe('acquireStateLock — happy path', () => {
  it('creates the lock file with the full identity + runtime provenance payload', () => {
    const lock = acquireStateLock(dir, IDENTITY, deps());
    expect(lock.path).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    expect(readLockFile()).toEqual({
      v: 1,
      pid: 4242,
      hostname: 'host-a',
      acquiredAt: '2026-06-15T00:00:00.000Z',
      maker: IDENTITY.maker,
      configPath: IDENTITY.configPath,
      runId: 'run-1',
      process: 'run --live',
    });
  });

  it('creates state.dir if it does not exist yet', () => {
    const nested = join(dir, 'deeper', 'state');
    const lock = acquireStateLock(nested, IDENTITY, deps());
    expect(existsSync(join(nested, STATE_LOCK_FILE))).toBe(true);
    lock.release();
  });

  it('records a null maker / configPath when the caller could not resolve them', () => {
    acquireStateLock(dir, { maker: null, configPath: null, runId: 'r', process: 'run --dry-run' }, deps());
    const payload = readLockFile();
    expect(payload.maker).toBeNull();
    expect(payload.configPath).toBeNull();
  });

  it('writes the lock file at mode 0o600 on POSIX', () => {
    acquireStateLock(dir, IDENTITY, deps());
    if (platform !== 'win32') {
      expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    }
  });
});

// ── updateMaker — stamp the resolved wallet post-unlock ────────────────────────

describe('StateLock.updateMaker', () => {
  const LIVE_MAKER = '0x1234000000000000000000000000000000001234';

  it('stamps a maker onto a lock acquired with a null maker, preserving every other field (the live Foundry-keystore case)', () => {
    const lock = acquireStateLock(dir, { maker: null, configPath: '/c.yaml', runId: 'run-1', process: 'run --live' }, deps());
    expect(readLockFile().maker).toBeNull();
    lock.updateMaker(LIVE_MAKER);
    expect(readLockFile()).toEqual({
      v: 1, pid: 4242, hostname: 'host-a', acquiredAt: '2026-06-15T00:00:00.000Z',
      maker: LIVE_MAKER, configPath: '/c.yaml', runId: 'run-1', process: 'run --live',
    });
  });

  it('does NOT rewrite a lock another instance reclaimed after us (pid/host/runId no longer ours)', () => {
    const lock = acquireStateLock(dir, IDENTITY, deps());
    // Simulate a different instance reclaiming the lock file.
    seedLock({ v: 1, pid: 9999, hostname: 'host-a', acquiredAt: 't', maker: '0xsibling', configPath: null, runId: 'other-run', process: 'run --live' });
    lock.updateMaker(LIVE_MAKER);
    expect(readLockFile().maker).toBe('0xsibling'); // untouched
    expect(readLockFile().runId).toBe('other-run');
  });

  it('is a no-op after release', () => {
    const lock = acquireStateLock(dir, IDENTITY, deps());
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
    lock.updateMaker(LIVE_MAKER); // must not recreate or throw
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ── acquire — fail closed on a live holder ─────────────────────────────────────

describe('acquireStateLock — fails closed on a live duplicate', () => {
  it('refuses when a same-host lock is held by a live process; leaves the existing lock untouched', () => {
    seedLock({ v: 1, pid: 999, hostname: 'host-a', acquiredAt: 't0', maker: '0xdead', configPath: '/c.yaml', runId: 'other', process: 'run --live' });
    const isProcessAlive = vi.fn(() => true);
    expect(() => acquireStateLock(dir, IDENTITY, deps({ isProcessAlive }))).toThrow(StateLockError);
    expect(isProcessAlive).toHaveBeenCalledWith(999);
    // The other instance's lock must not be overwritten.
    expect(readLockFile().runId).toBe('other');
  });

  it('the duplicate-holder error names the conflicting holder identity + the lock path', () => {
    seedLock({ v: 1, pid: 999, hostname: 'host-a', acquiredAt: 't0', maker: '0xdead', configPath: '/c.yaml', runId: 'other-run', process: 'run --live' });
    let caught: Error | undefined;
    try {
      acquireStateLock(dir, IDENTITY, deps({ isProcessAlive: () => true }));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(StateLockError);
    expect(caught?.message).toMatch(/already running/);
    expect(caught?.message).toContain('999');
    expect(caught?.message).toContain('other-run');
    expect(caught?.message).toContain(lockPath);
  });
});

// ── acquire — cross-host ───────────────────────────────────────────────────────

describe('acquireStateLock — cross-host lock', () => {
  it('fails closed when the lock is held on a different host (liveness unverifiable) without probing the pid', () => {
    seedLock({ v: 1, pid: 5, hostname: 'host-b', acquiredAt: 't0', maker: null, configPath: null, runId: 'remote', process: 'run --live' });
    const isProcessAlive = vi.fn(() => false);
    let caught: Error | undefined;
    try {
      acquireStateLock(dir, IDENTITY, deps({ hostname: 'host-a', isProcessAlive }));
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(StateLockError);
    expect(caught?.message).toMatch(/different host/);
    // A pid on another host is meaningless — never probe it.
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect(readLockFile().runId).toBe('remote');
  });
});

// ── acquire — corrupt lock ─────────────────────────────────────────────────────

describe('acquireStateLock — corrupt / unparseable lock', () => {
  it('fails closed on a non-JSON lock file (e.g. a partial write from a crashed acquire)', () => {
    writeFileSync(lockPath, 'not-json{', 'utf8');
    expect(() => acquireStateLock(dir, IDENTITY, deps())).toThrow(/couldn't be read/);
    expect(readFileSync(lockPath, 'utf8')).toBe('not-json{'); // untouched
  });

  it('fails closed on a JSON lock missing a usable pid', () => {
    seedLock({ v: 1, hostname: 'host-a', runId: 'x' }); // no pid
    expect(() => acquireStateLock(dir, IDENTITY, deps())).toThrow(StateLockError);
  });

  it('honors a minimal-but-valid lock (pid + hostname only) — not treated as corrupt', () => {
    seedLock({ pid: 999, hostname: 'host-a' });
    expect(() => acquireStateLock(dir, IDENTITY, deps({ isProcessAlive: () => true }))).toThrow(/already running/);
  });
});

// ── acquire — stale dead-PID reclaim ───────────────────────────────────────────

describe('acquireStateLock — stale dead-PID reclaim', () => {
  it('reclaims a same-host lock whose recorded process is dead, then acquires for us', () => {
    seedLock({ v: 1, pid: 999, hostname: 'host-a', acquiredAt: 't0', maker: null, configPath: null, runId: 'crashed', process: 'run --live' });
    const isProcessAlive = vi.fn((pid: number) => pid !== 999); // 999 is dead
    const lock = acquireStateLock(dir, IDENTITY, deps({ isProcessAlive }));
    expect(isProcessAlive).toHaveBeenCalledWith(999);
    const payload = readLockFile();
    expect(payload.pid).toBe(4242); // ours now
    expect(payload.runId).toBe('run-1');
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ── release ────────────────────────────────────────────────────────────────────

describe('StateLock.release', () => {
  it('removes the lock file', () => {
    const lock = acquireStateLock(dir, IDENTITY, deps());
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('is idempotent — a second release is a no-op', () => {
    const lock = acquireStateLock(dir, IDENTITY, deps());
    lock.release();
    expect(() => lock.release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does NOT remove a lock another instance legitimately reclaimed (different runId/pid)', () => {
    const lock = acquireStateLock(dir, IDENTITY, deps());
    // Simulate another instance reclaiming the dir after us (we were wrongly judged dead).
    seedLock({ v: 1, pid: 7777, hostname: 'host-a', acquiredAt: 't1', maker: null, configPath: null, runId: 'sibling', process: 'run --live' });
    lock.release();
    expect(existsSync(lockPath)).toBe(true); // the sibling's lock survives
    expect(readLockFile().runId).toBe('sibling');
  });

  it('does not throw if the lock file already vanished', () => {
    const lock = acquireStateLock(dir, IDENTITY, deps());
    rmSync(lockPath, { force: true });
    expect(() => lock.release()).not.toThrow();
  });
});

// ── default liveness probe ─────────────────────────────────────────────────────

describe('acquireStateLock — default liveness probe', () => {
  it('treats the real current process as alive (a lock held by process.pid blocks a second acquire)', () => {
    // First acquire uses the real default pid (process.pid) + real hostname + real probe.
    const lock = acquireStateLock(dir, IDENTITY); // no deps → all defaults
    // A second acquire (also defaults) sees the live current-process lock and fails closed.
    expect(() => acquireStateLock(dir, { ...IDENTITY, runId: 'run-2' })).toThrow(StateLockError);
    lock.release();
    // Once released, a fresh acquire succeeds.
    const again = acquireStateLock(dir, { ...IDENTITY, runId: 'run-3' });
    expect(readLockFile().runId).toBe('run-3');
    again.release();
  });
});
