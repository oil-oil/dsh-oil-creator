import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function parsePackMetadata(output: string) {
  const jsonMatch = output.match(/(?:^|\n)\[\s*\{/);
  if (!jsonMatch || jsonMatch.index === undefined) {
    throw new Error(`npm pack did not return JSON:\n${output}`);
  }
  const jsonStart = jsonMatch.index + (output[jsonMatch.index] === "\n" ? 1 : 0);
  return JSON.parse(output.slice(jsonStart)) as Array<{
    filename?: string;
    files?: Array<{ path: string }>;
  }>;
}

describe("DeepSeek Harness bundle packaging", () => {
  it("inserts its own plugin without overriding Desktop navigation", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as {
      files?: string[];
      scripts?: Record<string, string>;
      engines?: { node?: string };
      dsh?: {
        bundle?: { patch?: string };
        client?: { inject?: string[] };
      };
      peerDependencies?: Record<string, string>;
      repository?: { type?: string; url?: string };
      bugs?: { url?: string };
      homepage?: string;
    };
    const patch = readFileSync(resolve(root, "cordis.patch.yml"), "utf8");
    const copyInplace = readFileSync(
      resolve(root, "scripts/copy-inplace.mjs"),
      "utf8",
    );
    const releaseCheck = readFileSync(
      resolve(root, "scripts/check-release.mjs"),
      "utf8",
    );

    expect(manifest.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(manifest.files).toContain("cordis.patch.yml");
    expect(manifest.files).toContain("README.md");
    expect(manifest.files).toContain("assets/readme/hero.svg");
    expect(manifest.files).toContain("LICENSE");
    expect(manifest.files).toContain("docs/*.md");
    expect(manifest.scripts?.prepare).toBe("npm run build");
    expect(manifest.scripts?.["release:check"]).toBe(
      "node scripts/check-release.mjs",
    );
    expect(manifest.engines?.node).toBe(">=22.19.0");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/oil-oil/dsh-oil-creator.git",
    });
    expect(manifest.bugs?.url).toBe(
      "https://github.com/oil-oil/dsh-oil-creator/issues",
    );
    expect(manifest.homepage).toBe(
      "https://github.com/oil-oil/dsh-oil-creator#readme",
    );
    expect(manifest.dsh?.client?.inject).toEqual(expect.arrayContaining([
      "dsh-desktop-workbenches", "@deepseek-ai/dsh-client-ui-workspace",
      "@deepseek-ai/dsh-api-settings-controller",
    ]));
    expect(manifest.dsh?.client?.inject).not.toContain("@deepseek-ai/dsh-client-ui-sidebar");
    for (const range of Object.values(manifest.peerDependencies ?? {})) {
      expect(range).not.toContain("0.1.1-rc.2");
    }
    expect(patch.trim()).toBe("- insert:\n    - id: dsh-oil-creator\n      name: dsh-oil-creator");
    expect(copyInplace).not.toContain(".dsh/profiles");
    expect(copyInplace).toContain("libDirectory");
    expect(releaseCheck).toContain('run(root, "pnpm", ["check"])');
    expect(releaseCheck).toContain(
      '"pack", "--dry-run", "--ignore-scripts", "--json"',
    );
  });

  it("keeps README assets and runtime files in the real npm tarball", () => {
    const packDirectory = mkdtempSync(join(tmpdir(), "dsh-oil-creator-pack-"));
    const runtimeFiles = [
      "lib/index.js",
      "lib/client.js",
      "lib/typert.host.js",
      "lib/collect-publish.mjs",
    ];

    try {
      for (const runtimeFile of runtimeFiles) {
        expect(existsSync(resolve(root, runtimeFile))).toBe(true);
        expect(readFileSync(resolve(root, runtimeFile), "utf8")).not.toContain(root.replace(/\/$/, ""));
      }

      const output = execFileSync(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          packDirectory,
        ],
        { cwd: root, encoding: "utf8" },
      );
      const metadata = parsePackMetadata(output);
      const filename = metadata[0]?.filename;
      expect(filename).toBeTruthy();

      const tarball = resolve(packDirectory, filename!);
      expect(existsSync(tarball)).toBe(true);

      const entries = execFileSync("tar", ["-tzf", tarball], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((entry) => entry.replace(/^package\//, ""));
      const packedFiles = new Set(entries);

      expect([...packedFiles]).toEqual(expect.arrayContaining([
        "README.md",
        "assets/readme/hero.svg",
        "LICENSE",
        "cordis.patch.yml",
        "lib/index.js",
        "lib/client.js",
        "lib/typert.host.js",
        "lib/collect-publish.mjs",
      ]));
      expect(
        [...packedFiles].some((entry) => entry.startsWith("assets/readme/source/")),
      ).toBe(false);
    } finally {
      rmSync(packDirectory, { recursive: true, force: true });
    }
  });
});
