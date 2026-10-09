// Drive one request through handleRequest on a connection that only records
// what the daemon writes, for the op tests that stub the daemon around one op.
// Every line written is read as a frame of the wire's schemas, as the
// TestClient does, and a line that does not read fails the request.
import { handleRequest, type Conn, type Daemon } from "../src/server.ts";
import { frameProblem, requestOpOf } from "./helpers.ts";

/** Resolve once `count` frames (replies and pushes, in write order) have been
 * written back; reject at the first line outside the wire's schemas. */
export function requestFrames(
  daemon: Daemon,
  identity: Conn["identity"],
  request: object,
  count: number,
): Promise<Record<string, any>[]> {
  const op = "request_id" in request ? requestOpOf(request) : undefined;
  return new Promise((resolve, reject) => {
    const frames: Record<string, any>[] = [];
    const conn: Conn = {
      identity,
      subscribed: false,
      write(line) {
        const problem = frameProblem(line.trimEnd(), op);
        if (problem !== undefined) reject(new Error(`${problem}: ${line}`));
        frames.push(JSON.parse(line));
        if (frames.length === count) resolve(frames);
      },
    };
    // Register like the real transports do.
    daemon.connections.add(conn);
    handleRequest(daemon, conn, JSON.stringify(request));
  });
}

/** The single frame one request is answered with. */
export function requestOnce(
  daemon: Daemon,
  identity: Conn["identity"],
  request: object,
): Promise<Record<string, any>> {
  return requestFrames(daemon, identity, request, 1).then((frames) => frames[0]!);
}
