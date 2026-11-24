// node:zlib's brotliCompress, replaced for a fixture's process before it
// loads the app (mock.module reaches the app's named import, and it is not
// undone, so it is only used in a process of its own). Each brotli the app
// asks for is recorded with the quality it asks for, and starts only once
// the fixture releases it, at the lowest quality: what the fixtures check is
// which coding is served and that it decodes to the same bytes, and the
// quality the app chose is checked from the record, so the highest quality's
// seconds of CPU are not spent.
import { mock } from "bun:test";
import * as zlib from "node:zlib";

const real = { ...zlib };
const QUALITY = zlib.constants.BROTLI_PARAM_QUALITY;

/** The quality of each brotli the app asked for, in order, and how many of
 * them have started. */
export const brotliCalls: { asked: (number | boolean | undefined)[]; started: number } = {
  asked: [],
  started: 0,
};

const { promise: released, resolve: releaseBrotli } = Promise.withResolvers<void>();
/** Let the brotli the app asked for (and asks for from now on) start. */
export { releaseBrotli };

await mock.module("node:zlib", () => ({
  ...real,
  brotliCompress: (
    buf: zlib.InputType,
    options: zlib.BrotliOptions,
    callback: zlib.CompressCallback,
  ) => {
    brotliCalls.asked.push(options.params?.[QUALITY]);
    void released.then(() => {
      brotliCalls.started += 1;
      real.brotliCompress(
        buf,
        { ...options, params: { ...options.params, [QUALITY]: zlib.constants.BROTLI_MIN_QUALITY } },
        callback,
      );
    });
  },
}));
