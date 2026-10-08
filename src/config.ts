import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import Schema from "@deepseek-ai/schemastery";

export interface Config {
  libraryRoot: string;
  dataDir: string;
  subtitleSkillDir: string;
  coverSkillDir: string;
}

export function defaultLibraryRoot(platform: NodeJS.Platform = process.platform): string {
  const videos = platform === "darwin" ? "Movies" : "Videos";
  return join(homedir(), videos, "视频项目");
}

export function defaultDataDir(): string {
  return join(homedir(), ".dsh-oil-creator");
}

export function defaultSubtitleSkillDir(): string {
  return join(homedir(), ".claude", "skills", "oil-subtitle");
}

export function defaultCoverSkillDir(): string {
  return join(homedir(), ".claude", "skills", "oil-cover");
}

export function skillDirCandidates(skillName: string, home = homedir()): string[] {
  return [
    join(home, ".claude", "skills", skillName),
    join(home, ".codex", "skills", skillName),
    join(home, ".agents", "skills", skillName),
    join(home, ".grok", "skills", skillName),
  ];
}

function joinUnderHome(home: string, rest: string): string {
  return join(home, ...rest.replaceAll("\\", "/").split("/").filter(Boolean));
}

export function expandHomePath(path: string, home = homedir()): string {
  const trimmed = path.trim();
  if (trimmed === "~" || trimmed === "%USERPROFILE%" || trimmed === "%HOME%") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return joinUnderHome(home, trimmed.slice(2));
  const windowsHome = /^%(?:USERPROFILE|HOME)%([\\/].*)?$/i.exec(trimmed);
  if (windowsHome !== null) {
    const rest = windowsHome[1];
    return rest === undefined || rest === "" ? home : joinUnderHome(home, rest);
  }
  return trimmed;
}

/** @deprecated Use {@link defaultLibraryRoot}. Kept so existing imports keep working. */
export const DEFAULT_LIBRARY_ROOT = defaultLibraryRoot();

export const Config = Schema.object({
  libraryRoot: Schema.string().default(defaultLibraryRoot()),
  dataDir: Schema.string().default(defaultDataDir()),
  subtitleSkillDir: Schema.string().default(""),
  coverSkillDir: Schema.string().default(""),
});

export function resolveDataDir(config: Config): string {
  return config.dataDir === "" ? defaultDataDir() : config.dataDir;
}

export function resolveConfiguredPath(configured: string, fallback: string, envValue?: string): string {
  if (configured.trim() !== "") return configured;
  if (envValue !== undefined && envValue.trim() !== "") return envValue;
  return fallback;
}

export function resolveSkillDir(
  configured: string,
  skillName: string,
  envValue?: string,
): string {
  if (configured.trim() !== "") return expandHomePath(configured);
  if (envValue !== undefined && envValue.trim() !== "") return expandHomePath(envValue);
  return skillDirCandidates(skillName).find((candidate) => existsSync(candidate))
    ?? skillDirCandidates(skillName)[0]!;
}
