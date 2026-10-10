import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import { normalizeEnabledPlatforms } from "./overlay.ts";
import { PUBLISH_PLATFORMS } from "./platforms.ts";
import { isPublishMark, isPublishPlatform } from "./publishStatus.ts";
import type { OilCreatorService } from "./service.ts";
import type { CreatorProfile, PublishPlatform } from "./types.ts";

interface ToolsContext {
  tools: { register: (tool: ToolDefinition) => void };
}

function signalOf(exec: { signal: AbortSignal }): AbortSignal {
  return exec.signal;
}

function compactText(title: string, detail: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: `${title}: ${detail}` }];
}

function asJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as never;
}

function present(title: string, rawInput: unknown): { card: "generic"; title: string; kind: "other"; rawInput: unknown } {
  return { card: "generic", title, kind: "other", rawInput };
}

const JSON_VALUE = { type: "json" } as const;

export function registerCreatorTools(ctx: ToolsContext, service: OilCreatorService): void {
  ctx.tools.register(defineTool({
    name: "oil_creator_guide",
    description:
      "Self-bootstrap guide for this plugin. Call this when the user asks what this plugin does, "
      + "how to use it, or when you are unsure which step comes next. "
      + "Returns the full workflow (library, script rules, subtitles, covers, publish, data sync) "
      + "with the live capability status, including whether Ego Browser is available for auto-publish and data collection.",
    parameters: {},
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const result = value as { status?: { capabilities?: Record<string, { state?: string }> } };
        const capabilities = Object.values(result.status?.capabilities ?? {});
        const ready = capabilities.filter((item) => item.state === "ready").length;
        return compactText("Guide", `${ready}/${capabilities.length} capabilities ready`);
      },
    },
    presentCall: (args) => present("Creator guide", args),
    execute: (_args, exec) => service.getCreatorGuide(signalOf(exec)).then(asJson),
  }));

  ctx.tools.register(defineTool({
    name: "oil_script_rules",
    description:
      "Read or update the creator's script rules (persona): tone, structure, audience, and taboos "
      + "that every script.md must follow. Omit text to read. Send text to save. Empty text clears. "
      + "Ask the user about their persona before writing rules for the first time; merge new long-term "
      + "preferences into the existing rules instead of replacing them.",
    parameters: {
      text: { type: "string", description: "Full script rules text. Omit to read. Empty string clears." },
    },
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const settings = value as { scriptRules?: string };
        return compactText("Script rules", settings.scriptRules === undefined ? "not set" : "saved");
      },
    },
    presentCall: (args) => present("Script rules", args),
    async execute(args, exec) {
      const signal = signalOf(exec);
      if (typeof args.text !== "string") {
        return asJson(await service.getSettings({}, signal));
      }
      return asJson(await service.setScriptRules({ text: args.text }, signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_creator_setup",
    description:
      "Inspect the creator workspace, optional local capabilities, credential status, and current configuration. "
      + "Omit fields for a read-only diagnosis. Proposed changes are previewed unless apply=true. "
      + "Only use apply=true after the user confirms the exact directory and enabled platform changes.",
    parameters: {
      apply: { type: "boolean", description: "False previews changes. True saves them after user confirmation." },
      libraryRoot: { type: "string", description: "Existing absolute content directory, or a path starting with ~/." },
      enabledPlatforms: {
        type: "array",
        items: { type: "string", enum: PUBLISH_PLATFORMS },
        description: "Complete list of enabled platforms. Empty disables all platforms.",
      },
    },
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const result = value as {
          applied?: boolean;
          status?: { capabilities?: Record<string, { state?: string }> };
        };
        const capabilities = Object.values(result.status?.capabilities ?? {});
        const ready = capabilities.filter((item) => item.state === "ready").length;
        return compactText(result.applied ? "Setup applied" : "Setup checked", `${ready}/${capabilities.length} capabilities ready`);
      },
    },
    presentCall: (args) => present("Creator setup", args),
    async execute(args, exec) {
      const request = {
        apply: args.apply === true,
        ...(typeof args.libraryRoot === "string" ? { libraryRoot: args.libraryRoot } : {}),
        ...(Array.isArray(args.enabledPlatforms)
          ? { enabledPlatforms: normalizeEnabledPlatforms(args.enabledPlatforms) }
          : {}),
      };
      return asJson(await service.configureCreator(request, signalOf(exec)));
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_create_content",
    description:
      "Create an empty dated library folder named YYYY-MM-DD_title using today's date and a readable title.",
    parameters: {
      title: { type: "string", required: true, description: "Episode title. Hyphens become spaces." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          folderPath: { type: "string", required: true },
        },
      },
      render: (_args, value) => compactText("Created", value.id),
    },
    presentCall: (args) => present("Create content", args),
    execute: (args, exec) => {
      if (args.title.trim() === "") throw new Error("title is required");
      return service.createContent({ title: args.title }, signalOf(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_update_content",
    description:
      "Write overlay-only marks for one episode: readyToRecord, bind a Screen Studio project, "
      + "or set a platform publish status. To change topic.md or script.md, write those files "
      + "in the episode folder with the built-in file tools.",
    parameters: {
      id: { type: "string", required: true, description: "Folder id." },
      readyToRecord: { type: "boolean", description: "True moves idle content to 待录制." },
      studioPath: { type: "string", description: "Bind a .screenstudio project to this episode." },
      publishPlatform: {
        type: "string",
        enum: PUBLISH_PLATFORMS,
        description: "Platform to mark. Pair with publishStatus.",
      },
      publishStatus: {
        type: "string",
        enum: ["unpublished", "draft", "published"],
        description: "Per-platform publish mark stored in the plugin overlay.",
      },
      publishUrl: { type: "string", description: "Optional live URL when status is published." },
    },
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const record = value as { title?: string; id?: string };
        return compactText("Updated", record.title || record.id || "");
      },
    },
    presentCall: (args) => present("Update content", args),
    async execute(args, exec) {
      const signal = signalOf(exec);
      if (args.id === "") throw new Error("id is required");
      if (args.readyToRecord !== undefined) {
        await service.setContentStage({ id: args.id, readyToRecord: args.readyToRecord }, signal);
      }
      if (args.studioPath !== undefined && args.studioPath !== "") {
        await service.bindStudio({ id: args.id, path: args.studioPath }, signal);
      }
      const hasPlatform = args.publishPlatform !== undefined;
      const hasStatus = args.publishStatus !== undefined;
      if (hasPlatform !== hasStatus) {
        throw new Error("publishPlatform and publishStatus must be sent together");
      }
      if (isPublishPlatform(args.publishPlatform) && isPublishMark(args.publishStatus)) {
        await service.setPublish(
          args.publishUrl === undefined
            ? { id: args.id, platform: args.publishPlatform, status: args.publishStatus }
            : { id: args.id, platform: args.publishPlatform, status: args.publishStatus, url: args.publishUrl },
          signal,
        );
      }
      return asJson(await service.getContent({ id: args.id }, signal));
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_creator_profile",
    description:
      "Read or update the list of enabled publishing platforms. "
      + "Omit the list to read. Send the complete list to replace it.",
    parameters: {
      enabledPlatforms: {
        type: "array",
        items: { type: "string", enum: PUBLISH_PLATFORMS },
        description: "Complete list of enabled platforms. Empty disables all platforms.",
      },
    },
    output: {
      schema: JSON_VALUE,
      render: () => compactText("Profile", "saved"),
    },
    presentCall: (args) => present("Creator profile", args),
    async execute(args, exec) {
      const signal = signalOf(exec);
      const current = (await service.getSettings({}, signal)).profile;
      if (!Array.isArray(args.enabledPlatforms)) return asJson(current);
      const next: CreatorProfile = {
        enabledPlatforms: normalizeEnabledPlatforms(args.enabledPlatforms),
      };
      return asJson((await service.setProfile({ profile: next }, signal)).profile);
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_organize_library",
    description:
      "Preview or apply library folder cleanup to YYYY-MM-DD_readable title. "
      + "Adds a date from the recording/folder time when missing, and turns hyphens/underscores in titles into spaces. "
      + "Never deletes files. apply=false (default) only previews. Pass ids to limit the batch.",
    parameters: {
      apply: { type: "boolean", description: "False previews. True renames folders." },
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional folder ids to organize. Empty means the whole library.",
      },
    },
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const record = value as { moves?: unknown[] };
        const moves = Array.isArray(record.moves) ? record.moves : [];
        return compactText("Organize", `${moves.length} moves`);
      },
    },
    presentCall: (args) => present("Organize library", args),
    execute: async (args, exec) => asJson(await service.organizeLibrary({
      apply: args.apply === true,
      ids: args.ids ?? [],
    }, signalOf(exec))),
  }));

  ctx.tools.register(defineTool({
    name: "oil_sync_publish",
    description:
      "Sync published titles, URLs, and counts from logged-in creator dashboards. "
      + "Pass id to update one episode only and stop paging once that title is found. "
      + "Omit id to match the whole library and collect every page. "
      + "Requires Ego Lite and an already-logged-in creator session. "
      + "Repeats within 90 seconds reuse the last snapshot.",
    parameters: {
      id: {
        type: "string",
        description: "Folder id of one episode. Omit to sync the whole library.",
      },
      platform: {
        type: "string",
        enum: PUBLISH_PLATFORMS,
        description: "Collect only this platform. Omit to visit all enabled platforms.",
      },
      force: {
        type: "boolean",
        description: "Skip the 90-second cache and open creator pages again.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          matched: { type: "integer", required: true },
          platforms: { type: "json", required: true },
          cached: { type: "boolean" },
        },
      },
      render: (_args, value) => compactText("Sync publish", `${value.matched} matched`),
    },
    presentCall: (args) => present("Sync publish", args),
    execute: (args, exec) => {
      const request: {
        id?: string;
        platform?: PublishPlatform;
        force?: boolean;
      } = {};
      if (args.id !== undefined && args.id !== "") request.id = args.id;
      if (isPublishPlatform(args.platform)) request.platform = args.platform;
      if (args.force === true) request.force = true;
      return service.syncPublish(request, signalOf(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_open_studio",
    description:
      "Open the bound Screen Studio project for this episode so the user can review and export.",
    parameters: {
      id: { type: "string", required: true, description: "Folder id." },
    },
    output: {
      schema: JSON_VALUE,
      render: (_args, value) => {
        const record = value as { title?: string; id?: string };
        return compactText("Open Studio", record.title || record.id || "");
      },
    },
    presentCall: (args) => present("Open Studio", args),
    execute: async (args, exec) => {
      if (args.id === "") throw new Error("id is required");
      return asJson(await service.openStudio({ id: args.id }, signalOf(exec)));
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_open_subtitle_preview",
    description:
      "Open the oil-subtitle preview editor in the browser for this episode (video + editable cues).",
    parameters: {
      id: { type: "string", required: true, description: "Folder id." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          port: { type: "integer", required: true },
        },
      },
      render: (_args, value) => compactText("Subtitle preview", value.url),
    },
    presentCall: (args) => present("Subtitle preview", args),
    execute: (args, exec) => {
      if (args.id === "") throw new Error("id is required");
      return service.openSubtitlePreview({ id: args.id }, signalOf(exec));
    },
  }));

}
