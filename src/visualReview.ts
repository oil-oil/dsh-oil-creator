import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type {
  AttachmentStore,
  ImageAttachmentRef,
  ImageMediaType,
} from "@deepseek-ai/dsh-attachment";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { OilCreatorService } from "./service.ts";
import type { ContentCovers } from "./types.ts";

interface VisualToolsContext {
  attachments: AttachmentStore;
  tools: { register: (tool: ToolDefinition) => void };
}

export interface VisualFinding {
  severity: "info" | "warning" | "blocking";
  asset: string;
  issue: string;
  suggestion?: string;
}

export interface VisualReviewInput {
  verdict: "pass" | "needs_changes";
  summary: string;
  findings: VisualFinding[];
}

interface CoverReviewImage {
  ratio: string;
  attachment: ImageAttachmentRef;
}

interface CoverReviewResult {
  id: string;
  title: string;
  images: CoverReviewImage[];
}

const JSON_VALUE = { type: "json" } as const;
const COVER_RATIOS = ["3x4", "4x3", "16x9"] as const;

function missingCoverRatios(covers: ContentCovers): string[] {
  return COVER_RATIOS.filter((ratio) => covers[ratio] === undefined);
}

export function imageMediaType(path: string): ImageMediaType | undefined {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return undefined;
  }
}

async function prepareCoverReview(
  service: OilCreatorService,
  attachments: AttachmentStore,
  id: string,
  signal: AbortSignal,
): Promise<CoverReviewResult> {
  const detail = await service.getContent({ id }, signal);
  const missing = missingCoverRatios(detail.covers);
  if (missing.length > 0) throw new Error(`missing cover variants: ${missing.join(", ")}`);
  const candidates = COVER_RATIOS
    .flatMap((ratio) => {
      const path = detail.covers[ratio];
      return path === undefined ? [] : [{ ratio, path }];
    });
  if (candidates.length === 0) throw new Error(`no generated covers: ${id}`);
  const inputs = await Promise.all(candidates.map(async ({ path }) => {
    signal.throwIfAborted();
    const mediaType = imageMediaType(path);
    if (mediaType === undefined) throw new Error(`unsupported cover image: ${path}`);
    return { data: await readFile(path), mediaType, name: basename(path) };
  }));
  signal.throwIfAborted();
  const refs = await attachments.saveImages(inputs);
  return {
    id,
    title: detail.title,
    images: candidates.map((candidate, index) => ({
      ratio: candidate.ratio,
      attachment: refs[index] as ImageAttachmentRef,
    })),
  };
}

function reviewMarkdown(id: string, review: VisualReviewInput, createdAt: string): string {
  const verdict = review.verdict === "pass" ? "通过" : "需要修改";
  const rows = review.findings.length === 0
    ? "- 无"
    : review.findings.map((finding) => {
      const suggestion = finding.suggestion?.trim();
      return `- [${finding.severity}] ${finding.asset}：${finding.issue}`
        + (suggestion === undefined || suggestion === "" ? "" : `；建议：${suggestion}`);
    }).join("\n");
  return `# 视觉审查\n\n- 内容：${id}\n- 结论：${verdict}\n- 时间：${createdAt}\n\n## 总结\n\n${review.summary}\n\n## 问题清单\n\n${rows}\n`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function saveVisualReview(
  service: OilCreatorService,
  id: string,
  review: VisualReviewInput,
  signal: AbortSignal,
): Promise<{ jsonPath: string; markdownPath: string }> {
  signal.throwIfAborted();
  const detail = await service.getContent({ id }, signal);
  const missing = missingCoverRatios(detail.covers ?? {});
  if (review.verdict === "pass" && missing.length > 0) {
    throw new Error(`cannot pass visual review; missing cover variants: ${missing.join(", ")}`);
  }
  const createdAt = new Date().toISOString();
  const jsonPath = join(detail.folderPath, "visual-review.json");
  const markdownPath = join(detail.folderPath, "visual-review.md");
  const record = { schemaVersion: 1, id, createdAt, ...review };
  await atomicWrite(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  signal.throwIfAborted();
  await atomicWrite(markdownPath, reviewMarkdown(id, review, createdAt));
  return { jsonPath, markdownPath };
}

export function registerVisualReviewTools(ctx: VisualToolsContext, service: OilCreatorService): void {
  ctx.tools.register(defineTool({
    name: "oil_prepare_visual_review",
    description:
      "Load all generated cover variants for one episode into the multimodal model context. "
      + "Inspect composition, readability, safe areas, ratio adaptation, and brand consistency, then call oil_save_visual_review.",
    parameters: {
      id: { type: "string", required: true, description: "Folder id." },
    },
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const result = value as unknown as CoverReviewResult;
        return [
          {
            type: "text" as const,
            text: `${result.title}: cover images follow in this order: ${result.images.map((image) => image.ratio).join(", ")}`,
          },
          ...result.images.map((image) => ({
            type: "image" as const,
            attachment: image.attachment,
          })),
        ];
      },
    },
    presentCall: (args) => ({ card: "generic", title: "Prepare visual review", kind: "other", rawInput: args }),
    execute: async (args, exec) => {
      if (args.id.trim() === "") throw new Error("id is required");
      return prepareCoverReview(service, ctx.attachments, args.id, exec.signal) as never;
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_save_visual_review",
    description:
      "Persist a completed multimodal cover review into visual-review.json and visual-review.md in the episode folder. "
      + "Call only after oil_prepare_visual_review and include concrete findings for each affected ratio.",
    parameters: {
      id: { type: "string", required: true, description: "Folder id." },
      verdict: { type: "string", required: true, enum: ["pass", "needs_changes"] },
      summary: { type: "string", required: true, description: "Concise overall review." },
      findings: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { type: "string", required: true, enum: ["info", "warning", "blocking"] },
            asset: { type: "string", required: true, description: "Affected ratio or file name." },
            issue: { type: "string", required: true },
            suggestion: { type: "string" },
          },
        },
      },
    },
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const result = value as { markdownPath?: string };
        return [{ type: "text", text: `visual review saved: ${result.markdownPath ?? "visual-review.md"}` }];
      },
    },
    presentCall: (args) => ({ card: "generic", title: "Save visual review", kind: "other", rawInput: args }),
    execute: async (args, exec) => {
      if (args.id.trim() === "") throw new Error("id is required");
      if (args.summary.trim() === "") throw new Error("summary is required");
      const findings: VisualFinding[] = args.findings.map((finding) => {
        if (finding.asset.trim() === "" || finding.issue.trim() === "") {
          throw new Error("finding asset and issue are required");
        }
        return {
          severity: finding.severity,
          asset: finding.asset,
          issue: finding.issue,
          ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
        };
      });
      return saveVisualReview(service, args.id, {
        verdict: args.verdict,
        summary: args.summary,
        findings,
      }, exec.signal) as never;
    },
  }));
}
