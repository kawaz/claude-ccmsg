// A btw's launch command as a test drives it: what it was started with, the
// stream-json lines the test writes, and its end.
import type { BtwProcess } from "../src/btw.ts";

export class FakeBtwProcess<T> implements BtwProcess {
  readonly input: T;
  stopped = 0;
  readonly #out: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #err: ReadableStreamDefaultController<Uint8Array> | undefined;
  readonly #exit = Promise.withResolvers<number>();
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;

  constructor(input: T) {
    this.input = input;
    let out: ReadableStreamDefaultController<Uint8Array> | undefined;
    let err: ReadableStreamDefaultController<Uint8Array> | undefined;
    this.stdout = new ReadableStream({ start: (c) => void (out = c) });
    this.stderr = new ReadableStream({ start: (c) => void (err = c) });
    this.#out = out;
    this.#err = err;
    this.exited = this.#exit.promise;
  }

  write(...lines: string[]): void {
    for (const l of lines) this.#out?.enqueue(new TextEncoder().encode(`${l}\n`));
  }

  #ended = false;

  end(code: number, stderr = ""): void {
    if (this.#ended) return;
    this.#ended = true;
    if (stderr !== "") this.#err?.enqueue(new TextEncoder().encode(stderr));
    this.#out?.close();
    this.#err?.close();
    this.#exit.resolve(code);
  }

  stop(): void {
    this.stopped += 1;
    this.end(143);
  }
}
