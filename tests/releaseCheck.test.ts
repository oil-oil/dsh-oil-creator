import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseCheck = resolve(root, "scripts/check-release.mjs");
const buildScript = "tsdown && node scripts/copy-inplace.mjs scripts/collect-publish.mjs lib/collect-publish.mjs";
const REQUIRED_CHAIN_FILES = [
  "src/creatorSkill.ts",
  "src/capabilities.ts",
  "src/guide.ts",
  "src/platforms.ts",
  "src/client/publishPlatforms.ts",
  "src/settingsHost.ts",
  "src/backgroundJobs.ts",
  "src/visualReview.ts",
  "src/client/CreatorWorkbench.tsx",
  "src/client/workbench.ts",
  "tests/creatorSkill.test.ts",
  "tests/capabilities.test.ts",
  "tests/guide.test.ts",
  "tests/platforms.test.ts",
  "tests/creatorSettings.test.ts",
  "tests/contentInspector.test.ts",
  "tests/settingsHost.test.ts",
  "tests/backgroundJobs.test.ts",
  "tests/visualReview.test.ts",
  "tests/workbench.test.ts",
  "tests/clientApply.test.ts",
];

function git(repository: string, ...args: string[]) {
  execFileSync("git", args, { cwd: repository, stdio: "ignore" });
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "dsh-oil-creator-release-"));
  const files = new Map<string, string>([
    ["package.json", JSON.stringify({
      name: "dsh-oil-creator",
      version: "0.1.0",
      repository: {
        type: "git",
        url: "git+https://github.com/oil-oil/dsh-oil-creator.git",
      },
      bugs: { url: "https://github.com/oil-oil/dsh-oil-creator/issues" },
      homepage: "https://github.com/oil-oil/dsh-oil-creator#readme",
      packageManager: "pnpm@10.16.1",
      main: "./lib/index.js",
      exports: { ".": "./lib/index.js" },
      files: [
        "lib/index.js",
        "lib/client.js",
        "lib/typert.host.js",
        "lib/collect-publish.mjs",
        "cordis.patch.yml",
        "README.md",
        "assets/readme/hero.svg",
      ],
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
      scripts: {
        build: buildScript,
        prepare: "npm run build",
        typecheck: "tsc --noEmit",
        check: "pnpm typecheck && pnpm build && pnpm test",
        test: "vitest run",
        "release:check": "node scripts/check-release.mjs",
      },
    }, null, 2)],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"],
    ["cordis.patch.yml", "patch\n"],
    ["tsdown.config.ts", "export default {};\n"],
    ["vitest.config.ts", "export default {};\n"],
    ["scripts/collect-publish.mjs", "export {};\n"],
    ["scripts/copy-inplace.mjs", readFileSync(resolve(root, "scripts/copy-inplace.mjs"), "utf8")],
    ["scripts/check-release.mjs", readFileSync(releaseCheck, "utf8")],
    [".gitignore", "node_modules\n"],
    ["lib/index.js", "export {};\n"],
    ["lib/client.js", "module.exports = {};\n"],
    ["lib/typert.host.js", "export {};\n"],
    ["lib/collect-publish.mjs", "export {};\n"],
    ["src/index.ts", "export {};\n"],
    ["src/client/index.tsx", "export {};\n"],
    ...REQUIRED_CHAIN_FILES.map((file) => [file, "export {};\n"] as const),
    ["README.md", "# test\n"],
    ["assets/readme/hero.svg", "<svg />\n"],
    ["LICENSE", "MIT\n"],
  ]);

  for (const [file, contents] of files) {
    const path = join(repository, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  for (const command of ["tsc", "vitest", "tsdown"]) {
    const path = join(repository, "node_modules/.bin", command);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  git(repository, "init", "-q");
  git(repository, "config", "user.email", "release-check@example.test");
  git(repository, "config", "user.name", "release-check");
  git(repository, "add", "--all");
  git(repository, "commit", "-qm", "initial");
  git(repository, "remote", "add", "origin", "git@github.com:example/release-check.git");
  return repository;
}

function runReleaseCheck(repository: string) {
  try {
    return {
      code: 0,
      output: execFileSync(process.execPath, [releaseCheck, "--root", repository], {
        encoding: "utf8",
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("release:check", () => {
  it("accepts a clean repository with origin and tracked release files", () => {
    const repository = createRepository();
    try {
      const result = runReleaseCheck(repository);
      expect(result.code).toBe(0);
      expect(result.output).toContain("release:check 通过");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it("rejects dirty and untracked work trees with explicit reasons", () => {
    const dirty = createRepository();
    const untracked = createRepository();
    try {
      writeFileSync(join(dirty, "src/index.ts"), "export const dirty = true;\n");
      const dirtyResult = runReleaseCheck(dirty);
      expect(dirtyResult.code).not.toBe(0);
      expect(dirtyResult.output).toContain("工作树不干净");

      writeFileSync(join(untracked, "release-note.txt"), "not committed\n");
      const untrackedResult = runReleaseCheck(untracked);
      expect(untrackedResult.code).not.toBe(0);
      expect(untrackedResult.output).toContain("未跟踪发布文件");
      expect(untrackedResult.output).toContain("release-note.txt");
    } finally {
      rmSync(dirty, { recursive: true, force: true });
      rmSync(untracked, { recursive: true, force: true });
    }
  });

  it("rejects missing origin and missing files", () => {
    const noOrigin = createRepository();
    const missing = createRepository();
    try {
      git(noOrigin, "remote", "remove", "origin");
      const noOriginResult = runReleaseCheck(noOrigin);
      expect(noOriginResult.output).toContain("缺少 origin");

      rmSync(join(missing, "assets/readme/hero.svg"));
      const missingResult = runReleaseCheck(missing);
      expect(missingResult.output).toContain("关键文件缺失：assets/readme/hero.svg");

    } finally {
      rmSync(noOrigin, { recursive: true, force: true });
      rmSync(missing, { recursive: true, force: true });
    }
  });

  it.each(REQUIRED_CHAIN_FILES)("rejects an untracked critical chain file: %s", (file) => {
    const repository = createRepository();
    try {
      git(repository, "rm", "--cached", "--quiet", file);
      const result = runReleaseCheck(repository);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`关键文件未跟踪：${file}`);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
