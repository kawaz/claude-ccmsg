// The effort the webui's launch form preselects for each model (DR-0018 §3.9):
// `modelSettings.<model>.effortLevel` of the `settings.json` in the daemon's
// own CLAUDE_CONFIG_DIR, the config dir the launch command starts claude in
// when it keeps that variable (`keep_env`). The file is Claude Code's, so only
// the fields used are read and the rest let through; each model's setting is
// read on its own, so one that does not read leaves out that model alone.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  JsonValueSchema,
  jsonText,
  LaunchEffortSchema,
  LaunchModelSchema,
  parseWith,
  type LaunchEffort,
  type LaunchModel,
} from "@ccmsg/protocol";
import * as v from "valibot";

const ModelSettingSchema = v.optional(JsonValueSchema);

const SettingsTextSchema = jsonText(
  v.looseObject({
    modelSettings: v.optional(
      v.looseObject({
        fable: ModelSettingSchema,
        opus: ModelSettingSchema,
        sonnet: ModelSettingSchema,
        haiku: ModelSettingSchema,
      }),
    ),
  }),
);

const EffortLevelSchema = v.looseObject({ effortLevel: LaunchEffortSchema });

/** The config dir a claude started with `env` uses: CLAUDE_CONFIG_DIR, or
 * Claude Code's default `~/.claude` without it. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  const named = env.CLAUDE_CONFIG_DIR;
  return named !== undefined && named !== "" ? named : path.join(os.homedir(), ".claude");
}

/** The default effort of each model, read now. A missing or unreadable file
 * is no defaults; a model without a setting, or with an effort a launch
 * cannot name, is left out. */
export async function defaultEfforts(
  env: Readonly<Record<string, string | undefined>>,
): Promise<Partial<Record<LaunchModel, LaunchEffort>>> {
  let text: string;
  try {
    text = await fs.readFile(path.join(claudeConfigDir(env), "settings.json"), "utf8");
  } catch {
    return {};
  }
  const settings = parseWith(SettingsTextSchema, text);
  if (!settings.ok) return {};
  const modelSettings = settings.value.modelSettings;
  if (modelSettings === undefined) return {};
  const efforts: Partial<Record<LaunchModel, LaunchEffort>> = {};
  for (const model of LaunchModelSchema.options) {
    const read = parseWith(EffortLevelSchema, modelSettings[model]);
    if (read.ok) efforts[model] = read.value.effortLevel;
  }
  return efforts;
}
