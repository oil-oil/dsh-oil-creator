import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  imageMediaType,
  registerVisualReviewTools,
  saveVisualReview,
} from "../src/visualReview.ts";

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown>;
  output: { render: (args: unknown, value: unknown) => Array<{ type: string; attachment?: unknown }> };
}

describe("visual review tools", () => {
  it("maps only attachment-supported raster formats", () => {
    expect(imageMediaType("cover.PNG")).toBe("image/png");
    expect(imageMediaType("cover.jpeg")).toBe("image/jpeg");
    expect(imageMediaType("cover.svg")).toBeUndefined();
  });

  it("loads generated covers as multimodal attachment blocks", async () => {
    const folder = await mkdtemp(join(tmpdir(), "oil-visual-"));
    const covers = {
      "3x4": join(folder, "demo_3x4.png"),
      "4x3": join(folder, "demo_4x3.png"),
      "16x9": join(folder, "demo_16x9.png"),
    };
    await Promise.all(Object.values(covers).map((path) => writeFile(path, "png-bytes")));
    const refs = Object.entries(covers).map(([ratio, path]) => ({
      attachmentId: `sha256:${ratio}`,
      mediaType: "image/png",
      bytes: 9,
      width: 1080,
      height: 1440,
      name: path.split("/").at(-1),
    }));
    const saveImages = vi.fn(async () => refs);
    const registered: RegisteredTool[] = [];
    registerVisualReviewTools({
      attachments: { saveImages },
      tools: { register: (tool: unknown) => { registered.push(tool as RegisteredTool); } },
    } as never, {
      getContent: vi.fn(async () => ({
        id: "demo",
        title: "Demo",
        folderPath: folder,
        covers,
      })),
    } as never);
    const tool = registered.find((entry) => entry.name === "oil_prepare_visual_review");
    const result = await tool?.execute({ id: "demo" }, { signal: new AbortController().signal });
    const blocks = tool?.output.render({}, result);
    expect(saveImages).toHaveBeenCalledOnce();
    expect(blocks?.map((block) => block.type)).toEqual(["text", "image", "image", "image"]);
    expect(blocks?.slice(1).map((block) => block.attachment)).toEqual(refs);
  });

  it("refuses an incomplete three-ratio cover review", async () => {
    const registered: RegisteredTool[] = [];
    registerVisualReviewTools({
      attachments: { saveImages: vi.fn() },
      tools: { register: (tool: unknown) => { registered.push(tool as RegisteredTool); } },
    } as never, {
      getContent: vi.fn(async () => ({
        id: "demo",
        title: "Demo",
        covers: { "3x4": "/tmp/demo.png" },
      })),
    } as never);
    const tool = registered.find((entry) => entry.name === "oil_prepare_visual_review");
    await expect(tool?.execute({ id: "demo" }, { signal: new AbortController().signal }))
      .rejects.toThrow("missing cover variants: 4x3, 16x9");
  });

  it("atomically saves machine-readable and Chinese review artifacts", async () => {
    const folder = await mkdtemp(join(tmpdir(), "oil-review-"));
    const result = await saveVisualReview({
      getContent: vi.fn(async () => ({ folderPath: folder })),
    } as never, "demo", {
      verdict: "needs_changes",
      summary: "标题在小尺寸下不够清晰。",
      findings: [{
        severity: "blocking",
        asset: "3x4",
        issue: "标题与背景对比不足",
        suggestion: "增加暗色遮罩",
      }],
    }, new AbortController().signal);
    const json = JSON.parse(await readFile(result.jsonPath, "utf8")) as { schemaVersion: number; verdict: string };
    const markdown = await readFile(result.markdownPath, "utf8");
    expect(json).toMatchObject({ schemaVersion: 1, verdict: "needs_changes" });
    expect(markdown).toContain("# 视觉审查");
    expect(markdown).toContain("增加暗色遮罩");
  });
});
