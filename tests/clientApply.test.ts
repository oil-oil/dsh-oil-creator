import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { describe, expect, it, vi } from "vitest";

/** Exercise the shipped module through the Loader boundary, not a source-text approximation. */
function mountClient(pickDirectory = vi.fn(async (): Promise<string | null> => null)) {
  let client: { apply: (ctx: unknown) => void; inject: string[] } | undefined;
  let panel: (() => { props: { face: { createContent: (title: string) => Promise<unknown> } } }) | undefined;
  const pending: Promise<unknown>[] = [];
  const disposers: Array<() => unknown> = [];
  const release = vi.fn();
  const register = vi.fn((_descriptor: unknown, component: typeof panel) => { panel = component; return release; });
  const setLibraryRoot = vi.fn(async () => ({ ok: true, value: {} }));
  const createContent = vi.fn(async () => ({ ok: true, value: { id: "new", folderPath: "/chosen/new" } }));
  const remote = { setLibraryRoot, createContent, getRevision: async () => ({ ok: true, value: { revision: 0 } }) };
  const services: Record<string, unknown> = {
    desktopWorkbenches: { register, isActive: () => true, currentSession: () => undefined },
    uiWorkspace: { pickDirectory },
    "remote.oilCreator": remote,
  };
  const ctx = {
    fiber: { state: 1 },
    get: (name: string) => services[name],
    locale: { register: () => () => undefined, bind: () => (key: string) => key },
    remote: { $mount: async () => () => undefined },
    inject: () => undefined,
    effect: (setup: () => unknown) => {
      const result = setup();
      if (result !== null && typeof result === "object" && "then" in result) pending.push((result as Promise<unknown>).then((dispose) => { if (typeof dispose === "function") disposers.push(dispose as () => unknown); }));
      else if (typeof result === "function") disposers.push(result as () => unknown);
    },
  };
  const primitives = new Proxy({}, { get: (_target, key) => (props: object) => createElement(String(key), props) });
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load: ({ id, factory }: { id: string; factory: (require: (name: string) => unknown) => typeof client }) => {
      expect(id).toBe("dsh-oil-creator");
      client = factory((name) => {
        if (name === "react") return React;
        if (name === "react/jsx-runtime") return jsx;
        if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
        throw new Error(`Unexpected runtime module: ${name}`);
      });
    } } },
    setInterval: () => 1, clearInterval: () => undefined,
  });
  client!.apply(ctx);
  return { client: client!, register, panel: () => panel!(), pending, setLibraryRoot, createContent,
    dispose: async () => { await Promise.all(pending); for (const dispose of disposers.reverse()) await dispose(); }, release };
}

describe("Desktop workbench client", () => {
  it("registers only its business panel and releases it on unload", async () => {
    const mounted = mountClient();
    expect(mounted.client.inject).toContain("desktopWorkbenches");
    expect(mounted.register).toHaveBeenCalledOnce();
    expect(mounted.register.mock.calls[0]?.[0]).toMatchObject({ repository: "https://github.com/oil-oil/dsh-oil-creator" });
    expect(mounted.register.mock.calls[0]?.[0]).not.toHaveProperty("id");
    expect(mounted.panel().props.face).toBeDefined();
    await mounted.dispose();
    expect(mounted.release).toHaveBeenCalledOnce();
  });

  it("leaves configuration and files untouched when directory selection is cancelled", async () => {
    const mounted = mountClient();
    await expect(mounted.panel().props.face.createContent("Keep this title")).rejects.toThrow("已取消");
    expect(mounted.setLibraryRoot).not.toHaveBeenCalled();
    expect(mounted.createContent).not.toHaveBeenCalled();
    await mounted.dispose();
  });

  it("creates content under the chosen location without asking for a session", async () => {
    const mounted = mountClient(vi.fn(async () => "/chosen"));
    await expect(mounted.panel().props.face.createContent("New content")).resolves.toMatchObject({ id: "new" });
    expect(mounted.setLibraryRoot).toHaveBeenCalledWith({ path: "/chosen" });
    expect(mounted.createContent).toHaveBeenCalledWith({ title: "New content", libraryRoot: "/chosen" });
    await mounted.dispose();
  });
});
