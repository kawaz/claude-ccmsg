// Configuration files used to live in data/ (rooms/dumps' dir). They are
// declarative and hand-edited, so they belong under XDG_CONFIG_HOME; this moves
// what an existing install left behind, once, at startup.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Paths } from "./paths.ts";

/** Basenames that resolvePaths now places in configDir but older versions
 * wrote into dataDir. */
export const MIGRATED_CONFIG_FILES = ["config.json", "allowed-origins.json"] as const;

export interface MigrationLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Move config files an older install left in dataDir to configDir. A file
 * already present in configDir wins and the legacy copy is left untouched (with
 * a warning) rather than silently overwritten — the user may have edited both,
 * and only they can say which one is current. */
export function migrateLegacyConfigFiles(paths: Paths, log: MigrationLog): void {
  if (path.resolve(paths.configDir) === path.resolve(paths.dataDir)) return;
  for (const name of MIGRATED_CONFIG_FILES) {
    const legacy = path.join(paths.dataDir, name);
    const next = path.join(paths.configDir, name);
    if (!fs.existsSync(legacy)) continue;
    if (fs.existsSync(next)) {
      log.warn(`${next} and legacy ${legacy} both exist; using ${next} (delete the legacy one)`);
      continue;
    }
    try {
      fs.mkdirSync(paths.configDir, { recursive: true });
      moveFile(legacy, next);
      log.info(`moved ${legacy} to ${next}`);
    } catch (e) {
      log.warn(`could not move ${legacy} to ${next} (${String(e)}); reading neither`);
    }
  }
}

function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    // configDir and dataDir can sit on different filesystems, where rename(2)
    // fails with EXDEV; copy+unlink is the portable fallback.
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}
