import type { JobHooks, JobId, JobOutcome, JobRegistry, JobSpec } from "@deepseek-ai/dsh-jobs";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";

import type { OilCreatorService } from "./service.ts";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    "oil-media": "oil-media";
  }
}

interface JobToolsContext {
  jobs: JobRegistry;
  tools: { register: (tool: ToolDefinition) => void };
}

type MediaField = "burn" | "subtitleJob" | "coverJob";

const BACKGROUND_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", required: true, const: "background" },
    jobId: { type: "string", required: true },
  },
} as const;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function present(title: string, rawInput: unknown) {
  return { card: "generic" as const, title, kind: "execute" as const, rawInput };
}

function backgroundOutput() {
  return {
    schema: BACKGROUND_OUTPUT,
    render: (_args: unknown, value: { kind: "background"; jobId: string }) => [{
      type: "text" as const,
      text: `started background job ${value.jobId}`,
    }],
  };
}

async function assertMediaIdle(
  service: OilCreatorService,
  id: string,
  fields: readonly MediaField[],
  signal: AbortSignal,
): Promise<void> {
  const detail = await service.getContent({ id }, signal);
  const running = fields.find((field) => detail[field].status === "running");
  if (running !== undefined) throw new Error(`${id}: ${running} is already running`);
}

async function assertExportIdle(
  service: OilCreatorService,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const detail = await service.getContent({ id }, signal);
  if (detail.waitingForExport) throw new Error(`${id}: export wait is already running`);
}

function startExclusiveJob(
  jobs: JobRegistry,
  active: Set<string>,
  key: string,
  spec: Omit<JobSpec, "run">,
  run: () => JobHooks,
): JobId {
  if (active.has(key)) throw new Error(`${key}: background job is already running`);
  try {
    return jobs.start({
      ...spec,
      run: () => {
        if (active.has(key)) throw new Error(`${key}: background job is already running`);
        const hooks = run();
        active.add(key);
        void hooks.done.then(
          () => { active.delete(key); },
          () => { active.delete(key); },
        );
        return hooks;
      },
    });
  } catch (cause) {
    if (message(cause).includes("no job controller")) {
      throw new Error("background jobs unavailable: use the Harness standard or code preset with @deepseek-ai/dsh-tool-jobs");
    }
    throw cause;
  }
}

function mediaHooks(
  service: OilCreatorService,
  id: string,
  field: MediaField,
  start: (signal: AbortSignal) => Promise<unknown>,
): JobHooks {
  const controller = new AbortController();
  const done = (async (): Promise<JobOutcome> => {
    try {
      await start(controller.signal);
      const job = await service.waitForMediaJob(id, field, controller.signal);
      if (job.status === "done") {
        return { status: "completed", detail: field, result: job.output ?? `${id}: completed` };
      }
      return { status: "failed", detail: field, result: job.error ?? `${id}: failed` };
    } catch (cause) {
      if (controller.signal.aborted) {
        try {
          await service.cancelMediaJob(id, field);
        } catch (cleanupCause) {
          return { status: "failed", detail: "cancel cleanup failed", result: message(cleanupCause) };
        }
        return { status: "killed", detail: field, result: `${id}: cancelled` };
      }
      return { status: "failed", detail: field, result: message(cause) };
    }
  })();
  return {
    cancel: (reason) => {
      if (!controller.signal.aborted) controller.abort(new Error(reason ?? "cancelled"));
    },
    done,
  };
}

function exportHooks(
  service: OilCreatorService,
  id: string,
  timeoutMs: number | undefined,
): JobHooks {
  const controller = new AbortController();
  const done = (async (): Promise<JobOutcome> => {
    try {
      await service.waitForExport(
        timeoutMs === undefined ? { id } : { id, timeoutMs },
        controller.signal,
      );
      const detail = await service.waitForExportCompletion(id, controller.signal);
      if (detail.exportTimedOut === true) {
        return { status: "failed", detail: "export timed out", result: `${id}: export timed out` };
      }
      return {
        status: "completed",
        detail: "export ready",
        result: detail.videoSubtitled ?? detail.videoRaw ?? `${id}: export ready`,
      };
    } catch (cause) {
      if (controller.signal.aborted) {
        try {
          await service.cancelExportWait(id);
        } catch (cleanupCause) {
          return { status: "failed", detail: "cancel cleanup failed", result: message(cleanupCause) };
        }
        return { status: "killed", detail: "export wait", result: `${id}: cancelled` };
      }
      return { status: "failed", detail: "export wait", result: message(cause) };
    }
  })();
  return {
    cancel: (reason) => {
      if (!controller.signal.aborted) controller.abort(new Error(reason ?? "cancelled"));
    },
    done,
  };
}

export function registerCreatorJobTools(ctx: JobToolsContext, service: OilCreatorService): void {
  const active = new Set<string>();

  ctx.tools.register(defineTool({
    name: "oil_wait_export",
    description:
      "Watch an episode folder for a stable MP4/MOV export as a Harness background job. "
      + "Returns a job id immediately; use job_output with wait=true for completion and job_kill for cancellation.",
    parameters: {
      id: { type: "string", required: true, description: "Folder id." },
      timeoutMs: { type: "integer", description: "Timeout in milliseconds. Default 2 hours." },
    },
    output: backgroundOutput(),
    presentCall: (args) => present("Wait for export", args),
    execute: async (args, exec) => {
      if (args.id.trim() === "") throw new Error("id is required");
      exec.signal.throwIfAborted();
      await assertExportIdle(service, args.id, exec.signal);
      const jobId = startExclusiveJob(ctx.jobs, active, `${args.id}:export`, {
        kind: "oil-media",
        label: `Wait for export: ${args.id}`,
        ...(exec.agent === undefined ? {} : { owner: exec.agent.session.id }),
      }, () => exportHooks(service, args.id, args.timeoutMs));
      return { kind: "background" as const, jobId };
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_burn_subtitles",
    description:
      "Burn the confirmed subtitle draft as a Harness background job. "
      + "Open and confirm the subtitle preview first; use job_output with wait=true or job_kill for control.",
    parameters: { id: { type: "string", required: true, description: "Folder id." } },
    output: backgroundOutput(),
    presentCall: (args) => present("Burn subtitles", args),
    execute: async (args, exec) => {
      if (args.id.trim() === "") throw new Error("id is required");
      exec.signal.throwIfAborted();
      await assertMediaIdle(service, args.id, ["burn"], exec.signal);
      const jobId = startExclusiveJob(ctx.jobs, active, `${args.id}:burn`, {
        kind: "oil-media",
        label: `Burn subtitles: ${args.id}`,
        ...(exec.agent === undefined ? {} : { owner: exec.agent.session.id }),
      }, () => mediaHooks(service, args.id, "burn", (signal) =>
        service.startSubtitleBurn({ id: args.id }, signal)));
      return { kind: "background" as const, jobId };
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_generate_subtitles",
    description:
      "Transcribe, review, and lay out subtitle drafts as a Harness background job. "
      + "Completion opens the preview editor; use job_output with wait=true or job_kill for control.",
    parameters: { id: { type: "string", required: true, description: "Folder id." } },
    output: backgroundOutput(),
    presentCall: (args) => present("Generate subtitles", args),
    execute: async (args, exec) => {
      if (args.id.trim() === "") throw new Error("id is required");
      exec.signal.throwIfAborted();
      await assertMediaIdle(service, args.id, ["subtitleJob", "burn"], exec.signal);
      const jobId = startExclusiveJob(ctx.jobs, active, `${args.id}:subtitleJob`, {
        kind: "oil-media",
        label: `Generate subtitles: ${args.id}`,
        ...(exec.agent === undefined ? {} : { owner: exec.agent.session.id }),
      }, () => mediaHooks(service, args.id, "subtitleJob", (signal) =>
        service.startSubtitleGenerate({ id: args.id }, signal)));
      return { kind: "background" as const, jobId };
    },
  }));

  ctx.tools.register(defineTool({
    name: "oil_generate_cover",
    description:
      "Generate 3x4 / 4x3 / 16x9 covers as a Harness background job. "
      + "Extract and pass the cover headline first; use job_output with wait=true or job_kill for control.",
    parameters: {
      id: { type: "string", required: true, description: "Folder id." },
      title: { type: "string", description: "Cover headline extracted from the episode." },
    },
    output: backgroundOutput(),
    presentCall: (args) => present("Generate cover", args),
    execute: async (args, exec) => {
      if (args.id.trim() === "") throw new Error("id is required");
      exec.signal.throwIfAborted();
      await assertMediaIdle(service, args.id, ["coverJob"], exec.signal);
      const request = {
        id: args.id,
        ...(typeof args.title === "string" && args.title.trim() !== "" ? { title: args.title } : {}),
      };
      const jobId = startExclusiveJob(ctx.jobs, active, `${args.id}:coverJob`, {
        kind: "oil-media",
        label: `Generate cover: ${args.id}`,
        ...(exec.agent === undefined ? {} : { owner: exec.agent.session.id }),
      }, () => mediaHooks(service, args.id, "coverJob", (signal) =>
        service.startCoverGenerate(request, signal)));
      return { kind: "background" as const, jobId };
    },
  }));
}
