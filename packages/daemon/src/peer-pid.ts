// The process at the other end of a Unix socket connection (DR-0046 §3): the
// kernel's own record of who connected, which the connecting process cannot
// choose. Read with getsockopt(2) through bun:ffi, as no Bun or node:net API
// gives it.
//
// - macOS: `LOCAL_PEERPID` at level `SOL_LOCAL` (<sys/un.h>), the pid as an int
// - Linux: `SO_PEERCRED` at level `SOL_SOCKET` (<asm-generic/socket.h>), a
//   `struct ucred { pid_t pid; uid_t uid; gid_t gid; }`
//
// Verified with a Bun.listen server and a child connecting to it, Bun 1.4.2,
// on macOS 26 (arm64) and in the oven/bun:1.4.2 image (Linux, glibc).
import { dlopen, FFIType, ptr } from "bun:ffi";

const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

/** How the peer pid is read on this platform, or undefined on one this
 * module does not know the call for. */
const reading = ((): { lib: string; level: number; name: number; ints: number } | undefined => {
  if (process.platform === "darwin") {
    return { lib: "libSystem.B.dylib", level: SOL_LOCAL, name: LOCAL_PEERPID, ints: 1 };
  }
  if (process.platform === "linux") {
    return { lib: "libc.so.6", level: SOL_SOCKET, name: SO_PEERCRED, ints: 3 };
  }
  return undefined;
})();

const libc =
  reading === undefined
    ? undefined
    : dlopen(reading.lib, {
        getsockopt: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      });

/** The pid of the process at the other end of the connected Unix socket
 * `fd`, or undefined when it cannot be read (not a Unix socket, a platform
 * this module does not know). */
export function peerPid(fd: number): number | undefined {
  if (reading === undefined || libc === undefined) return undefined;
  const value = new Int32Array(reading.ints);
  const length = new Uint32Array([value.byteLength]);
  const rc = libc.symbols.getsockopt(fd, reading.level, reading.name, ptr(value), ptr(length));
  const pid = value[0];
  return rc === 0 && pid !== undefined && pid > 0 ? pid : undefined;
}
