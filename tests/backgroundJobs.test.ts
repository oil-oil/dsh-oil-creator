import { describe, expect, it, vi } from "vitest";

import { registerCreatorJobTools } from "../src/backgroundJobs.ts";

interface RegisteredTool {
  name: string;
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal; agent?: unknown }) => Promise<unknown>;
}

function setup(service: Record<string, unknown>) {
  const tools: RegisteredTool[] = [];
  let hooks: { cancel: (reason?: string) => void; done: Promise<unknown> } | undefined;
  registerCreatorJobTools({
    tools: { register: (tool: unknown) => { tools.push(tool as RegisteredTool); } },
    jobs: {
      start: (spec: { run: () => typeof hooks }) => {
        hooks = spec.run();
        return "oil-media-1";
      },
    },
  } as never, service as never);
  return { tools: new Map(tools.map((tool) => [tool.name, tool])), hooks: () => hooks };
}

describe("creator background jobs", () => {
  it("registers long media work with the Harness job registry", async () => {
    const service = {
      getContent: vi.fn(async () => ({
        waitingForExport: false,
        burn: { status: "idle" },
        subtitleJob: { status: "idle" },
        coverJob: { status: "idle" },
      })),
      startCoverGenerate: vi.fn(async () => ({})),
      waitForMediaJob: vi.fn(async () => ({ status: "done", output: "/tmp/cover.png" })),
      cancelMediaJob: vi.fn(async () => undefined),
    };
    const registered = setup(service);
    expect([...registered.tools.keys()]).toEqual([
      "oil_wait_export",
      "oil_burn_subtitles",
      "oil_generate_subtitles",
      "oil_generate_cover",
    ]);
    const result = await registered.tools.get("oil_generate_cover")?.execute(
      { id: "demo", title: "封面标题" },
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({ kind: "background", jobId: "oil-media-1" });
    await expect(registered.hooks()?.done).resolves.toEqual({
      status: "completed",
      detail: "coverJob",
      result: "/tmp/cover.png",
    });
    expect(service.startCoverGenerate).toHaveBeenCalledWith(
      { id: "demo", title: "封面标题" },
      expect.any(AbortSignal),
    );
  });

  it("routes job cancellation through the owned media process cleanup", async () => {
    const service = {
      getContent: vi.fn(async () => ({
        waitingForExport: false,
        burn: { status: "idle" },
        subtitleJob: { status: "idle" },
        coverJob: { status: "idle" },
      })),
      startCoverGenerate: vi.fn(async () => ({})),
      waitForMediaJob: vi.fn((_id, _field, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { reject(signal.reason); }, { once: true });
      })),
      cancelMediaJob: vi.fn(async () => undefined),
    };
    const registered = setup(service);
    await registered.tools.get("oil_generate_cover")?.execute(
      { id: "demo" },
      { signal: new AbortController().signal },
    );
    registered.hooks()?.cancel("user stopped");
    await expect(registered.hooks()?.done).resolves.toEqual({
      status: "killed",
      detail: "coverJob",
      result: "demo: cancelled",
    });
    expect(service.cancelMediaJob).toHaveBeenCalledWith("demo", "coverJob");
  });

  it("rejects a duplicate job for the same content and media field", async () => {
    const service = {
      getContent: vi.fn(async () => ({
        waitingForExport: false,
        burn: { status: "idle" },
        subtitleJob: { status: "idle" },
        coverJob: { status: "idle" },
      })),
      startCoverGenerate: vi.fn(async () => ({})),
      waitForMediaJob: vi.fn(() => new Promise(() => undefined)),
      cancelMediaJob: vi.fn(async () => undefined),
    };
    const registered = setup(service);
    const tool = registered.tools.get("oil_generate_cover");
    await tool?.execute({ id: "demo" }, { signal: new AbortController().signal });
    await expect(tool?.execute({ id: "demo" }, { signal: new AbortController().signal }))
      .rejects.toThrow("already running");
  });
});
