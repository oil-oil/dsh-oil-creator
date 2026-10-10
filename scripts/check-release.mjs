#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "cordis.patch.yml",
  "tsdown.config.ts",
  "vitest.config.ts",
  "scripts/collect-publish.mjs",
  "scripts/copy-inplace.mjs",
  "scripts/check-release.mjs",
  "src/index.ts",
  "src/client/index.tsx",
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
  "README.md",
  "assets/readme/hero.svg",
  "LICENSE",
];

const RUNTIME_FILES = [
  "lib/index.js",
  "lib/client.js",
  "lib/typert.host.js",
  "lib/collect-publish.mjs",
];

const GITHUB_REPOSITORY = "https://github.com/oil-oil/dsh-oil-creator";
const GITHUB_REPOSITORY_GIT = "git+https://github.com/oil-oil/dsh-oil-creator.git";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run(root, command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
}

function parseRootArgument() {
  const index = process.argv.indexOf("--root");
  return index === -1 ? undefined : process.argv[index + 1];
}

function checkRelease(root) {
  const failures = [];
  const addFailure = (message) => failures.push(message);

  let status = "";
  try {
    status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch (error) {
    addFailure(`无法读取 Git 工作树：${error.message}`);
  }

  const statusLines = status ? status.split("\n") : [];
  const untracked = statusLines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3));
  const changed = statusLines.filter((line) => !line.startsWith("?? "));
  if (changed.length > 0) {
    addFailure(`工作树不干净：${changed.join(", ")}`);
  }
  if (untracked.length > 0) {
    addFailure(`存在未跟踪发布文件：${untracked.join(", ")}`);
  }

  try {
    if (!git(root, ["remote", "get-url", "origin"])) {
      addFailure("缺少 origin 远程仓库");
    }
  } catch {
    addFailure("缺少 origin 远程仓库");
  }

  for (const file of REQUIRED_FILES) {
    const absolutePath = resolve(root, file);
    if (!existsSync(absolutePath)) {
      addFailure(`关键文件缺失：${file}`);
      continue;
    }
    try {
      git(root, ["ls-files", "--error-unmatch", "--", file]);
    } catch {
      addFailure(`关键文件未跟踪：${file}`);
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  } catch (error) {
    addFailure(`package.json 不可读取：${error.message}`);
    return failures;
  }

  const scripts = manifest.scripts ?? {};
  if (scripts.build !== "tsdown && node scripts/copy-inplace.mjs scripts/collect-publish.mjs lib/collect-publish.mjs") {
    addFailure("build 脚本不是仓库内可复现的 tsdown + lib 拷贝流程");
  }
  if (scripts.prepare !== "npm run build") {
    addFailure("prepare 必须固定为 npm run build");
  }
  if (typeof scripts.test !== "string" || scripts.test.length === 0) {
    addFailure("缺少 test 脚本");
  }
  if (scripts.check !== "pnpm typecheck && pnpm build && pnpm test") {
    addFailure("check 必须固定为完整的 pnpm typecheck、test、build 流程");
  }
  if (scripts["release:check"] !== "node scripts/check-release.mjs") {
    addFailure("缺少显式 release:check 门禁脚本");
  }
  if (typeof manifest.packageManager !== "string" || !manifest.packageManager.startsWith("pnpm@")) {
    addFailure("缺少固定版本的 pnpm packageManager");
  }
  if (manifest.repository?.type !== "git" || manifest.repository?.url !== GITHUB_REPOSITORY_GIT) {
    addFailure("repository 必须指向 GitHub 源码仓库");
  }
  if (manifest.bugs?.url !== `${GITHUB_REPOSITORY}/issues`) {
    addFailure("bugs 必须指向 GitHub Issues");
  }
  if (manifest.homepage !== `${GITHUB_REPOSITORY}#readme`) {
    addFailure("homepage 必须指向 GitHub README");
  }

  const copyScriptPath = resolve(root, "scripts/copy-inplace.mjs");
  if (existsSync(copyScriptPath)) {
    const buildScript = readFileSync(copyScriptPath, "utf8");
    if (
      buildScript.includes("homedir")
      || buildScript.includes(".dsh/profiles")
      || buildScript.includes(".dsh\\profiles")
    ) {
      addFailure("build 脚本仍包含对 ~/.dsh profile 的写入路径");
    }
    if (!buildScript.includes("libDirectory") || !buildScript.includes("writeFileSync(dest")) {
      addFailure("copy-inplace 未限制写入当前仓库 lib");
    }
  }

  const packageFiles = new Set(manifest.files ?? []);
  for (const file of [...RUNTIME_FILES, "cordis.patch.yml", "README.md", "assets/readme/hero.svg"]) {
    if (!packageFiles.has(file)) addFailure(`npm tarball 未声明 ${file}`);
  }
  if (manifest.main !== "./lib/index.js") addFailure("main 未指向预构建 lib/index.js");
  if (manifest.exports?.["."] !== "./lib/index.js") {
    addFailure("exports 根入口未指向预构建 lib/index.js");
  }
  if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") {
    addFailure("缺少可随包携带的 dsh.bundle.patch");
  }

  return failures;
}

function runReleasePipeline(root) {
  try {
    run(root, "pnpm", ["check"]);
  } catch (error) {
    return [`pnpm check 失败：${error.message}`];
  }

  let output;
  try {
    output = execFileSync(
      "npm",
      ["pack", "--dry-run", "--ignore-scripts", "--json"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
  } catch (error) {
    return [`npm pack --dry-run --ignore-scripts 失败：${error.message}`];
  }

  let metadata;
  try {
    metadata = JSON.parse(output);
  } catch (error) {
    return [`npm pack --dry-run 输出不可解析：${error.message}`];
  }

  const packedFiles = new Set(
    metadata.flatMap((pack) => pack.files ?? []).map((file) => file.path),
  );
  const missing = [...RUNTIME_FILES, "assets/readme/hero.svg"]
    .filter((file) => !packedFiles.has(file));
  return missing.length > 0
    ? [`npm pack --dry-run 缺少运行或 Hero 文件：${missing.join(", ")}`]
    : [];
}

const rootArgument = parseRootArgument();
let repositoryRoot;
try {
  repositoryRoot = resolve(rootArgument ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]));
} catch (error) {
  console.error(`release:check 失败\n- 当前目录不是 Git 仓库：${error.message}`);
  process.exitCode = 1;
}

if (repositoryRoot) {
  const failures = checkRelease(repositoryRoot);
  if (failures.length === 0) failures.push(...runReleasePipeline(repositoryRoot));
  if (failures.length > 0) {
    console.error(["release:check 失败", ...failures.map((failure) => `- ${failure}`)].join("\n"));
    process.exitCode = 1;
  } else {
    console.log("release:check 通过：工作树、Git 发布边界和打包元数据均满足要求");
  }
}
