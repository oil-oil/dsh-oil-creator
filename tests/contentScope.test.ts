import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OilCreatorService } from "../src/service.ts";
import { emptyOverlay, saveOverlay } from "../src/overlay.ts";

// User-picked paths and script targets must not cross another library with the same content id.
describe("content file scope", () => {
  it("retains both libraries' files when an obsolete editor attempts to save", async () => {
    const root = await mkdtemp(join(tmpdir(), "oil-content-scope-"));
    try {
      const a = join(root, "a", "same-id");
      const b = join(root, "b", "same-id");
      await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
      await writeFile(join(a, "script.md"), "script A"); await writeFile(join(b, "script.md"), "script B");
      const service = Object.create(OilCreatorService.prototype) as OilCreatorService;
      service.find = async () => ({ folderPath: b }) as never;
      await expect(service.setScript({ id: "same-id", folderPath: a, text: "draft A" }, new AbortController().signal))
        .rejects.toThrow("资料位置已切换");
      expect(await readFile(join(a, "script.md"), "utf8")).toBe("script A");
      expect(await readFile(join(b, "script.md"), "utf8")).toBe("script B");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rejects paths and symlinks outside the current library before opening anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "oil-open-scope-"));
    try {
      const library = join(root, "library"); const dataDir = join(root, "state");
      const outside = join(root, "outside.txt");
      await mkdir(library); await mkdir(dataDir); await writeFile(outside, "outside");
      await symlink(outside, join(library, "link.txt"));
      await saveOverlay(dataDir, { ...emptyOverlay(), libraryRoot: library });
      const service = Object.create(OilCreatorService.prototype) as OilCreatorService;
      Object.assign(service, { dataDir, libraryRoot: library });
      for (const path of [outside, join(library, "link.txt")]) {
        await expect(service.openContentPath({ path }, new AbortController().signal)).rejects.toThrow("只能打开");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
