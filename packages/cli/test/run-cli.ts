// Running the real `ccmsg` CLI from this working copy, for the tests that
// check what it prints and how it exits.
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export interface CliResult {
  out: string;
  err: string;
  code: number;
}

/** Run `ccmsg <args>` with `env` over this process's environment, in `cwd`
 * when given, and collect what it printed and its exit code. */
export async function runCli(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}
