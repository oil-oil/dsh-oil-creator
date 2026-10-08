import type { InvocationDescriptor } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";

import {
  capabilitiesResultSchema,
  contentDetailSchema,
  coverThumbResultSchema,
  idRequestSchema,
  librarySettingsSchema,
  listContentsRequestSchema,
  listContentsResultSchema,
  setLibraryRootRequestSchema,
  createContentRequestSchema,
  createContentResultSchema,
  setContentStageRequestSchema,
  setProfileRequestSchema,
  setScriptRulesRequestSchema,
  bindStudioRequestSchema,
  setPublishRequestSchema,
  setScriptRequestSchema,
  subtitlePreviewResultSchema,
  subtitleTextResultSchema,
  revisionResultSchema,
  syncPublishRequestSchema,
  syncPublishResultSchema,
  videoPlaybackResultSchema,
  articleMediaResultSchema,
} from "./schemas.ts";

export const PACKAGE_NAME = "dsh-oil-creator";
export const REMOTE_NAMESPACE = "oilCreator";

const emptyObjectSchema = z.object({});

function codec(typeSymbol: string, schema: z.ZodType<unknown>) {
  return { mode: "strict" as const, typeSymbol, create: () => schema };
}

function jsonParam(
  name: string,
  typeSymbol: string,
  schema: z.ZodType<unknown>,
): InvocationDescriptor["parameters"][number] {
  return {
    name,
    wire: name,
    source: "json",
    codec: codec(typeSymbol, schema),
  };
}

function invocation(
  method: string,
  request: z.ZodType<unknown>,
  result: z.ZodType<unknown>,
): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: "direct" },
    parameters: [jsonParam("request", `${PACKAGE_NAME}#${method}Request`, request)],
    cancellation: { parameter: "signal" },
    result: codec(`${PACKAGE_NAME}#${method}Result`, result),
    sourceLocation: { file: "src/service.ts", line: 1, column: 1 },
  };
}

export const OIL_CREATOR_INVOCATIONS: readonly InvocationDescriptor[] = [
  invocation("listContents", listContentsRequestSchema, listContentsResultSchema),
  invocation("getContent", idRequestSchema, contentDetailSchema),
  invocation("getCoverThumb", idRequestSchema, coverThumbResultSchema),
  invocation("getVideoPlayback", idRequestSchema, videoPlaybackResultSchema),
  invocation("getArticleMedia", idRequestSchema, articleMediaResultSchema),
  invocation("getSubtitleText", idRequestSchema, subtitleTextResultSchema),
  invocation("openContentPath", z.object({ path: z.string().min(1) }), emptyObjectSchema),
  invocation("getSettings", emptyObjectSchema, librarySettingsSchema),
  invocation("getCapabilities", emptyObjectSchema, capabilitiesResultSchema),
  invocation("getRevision", emptyObjectSchema, revisionResultSchema),
  invocation("setLibraryRoot", setLibraryRootRequestSchema, librarySettingsSchema),
  invocation("refreshCatalog", emptyObjectSchema, listContentsResultSchema),
  invocation("createContent", createContentRequestSchema, createContentResultSchema),
  invocation("setContentStage", setContentStageRequestSchema, contentDetailSchema),
  invocation("setProfile", setProfileRequestSchema, librarySettingsSchema),
  invocation("setScriptRules", setScriptRulesRequestSchema, librarySettingsSchema),
  invocation("bindStudio", bindStudioRequestSchema, contentDetailSchema),
  invocation("openStudio", idRequestSchema, contentDetailSchema),
  invocation("setPublish", setPublishRequestSchema, contentDetailSchema),
  invocation("syncPublish", syncPublishRequestSchema, syncPublishResultSchema),
  invocation("setScript", setScriptRequestSchema, contentDetailSchema),
  invocation("openSubtitlePreview", idRequestSchema, subtitlePreviewResultSchema),
  invocation("startSubtitleBurn", idRequestSchema, contentDetailSchema),
  invocation("startSubtitleGenerate", idRequestSchema, contentDetailSchema),
  invocation("startCoverGenerate", idRequestSchema, contentDetailSchema),
];
