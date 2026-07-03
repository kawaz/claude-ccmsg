// Single-instance guard via advisory file lock (DR-0002 §3). Neither Bun.file nor
// node:fs expose flock(2), so we call libc flock directly through bun:ffi. Verified
// on macOS in docs/findings/2026-07-03-bun-uds-compile-verification.md §4.
//
// Design rationale: libc name is platform-specific. macOS = libSystem, Linux = libc.
// Only macOS is empirically verified; the Linux path mirrors the standard flock(2)
// ABI (same constants) but is unverified — re-check before relying on it there.
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function libcName(): string {
  if (process.platform === "darwin") return "libSystem.B.dylib";
  // Linux glibc. Musl systems expose flock in libc.so as well.
  return "libc.so.6";
}

const lib = dlopen(libcName(), {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

export interface LockHandle {
  fd: number;
  release(): void;
}

/**
 * Try to acquire an exclusive, non-blocking lock on `lockPath`.
 * Returns a handle on success, or null if another process holds it.
 * The handle's fd stays open for the process lifetime to hold the lock.
 */
export function tryAcquireLock(lockPath: string): LockHandle | null {
  const fd = fs.openSync(lockPath, "w");
  const rc = lib.symbols.flock(fd, LOCK_EX | LOCK_NB);
  if (rc !== 0) {
    fs.closeSync(fd);
    return null;
  }
  // Record our pid in the lock file for debugging (content is advisory only).
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, `${process.pid}\n`, 0);
  } catch {
    // non-fatal: the lock, not its content, is what matters
  }
  return {
    fd,
    release() {
      try {
        lib.symbols.flock(fd, LOCK_UN);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}
