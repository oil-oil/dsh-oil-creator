import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkbenchNavigation, contentForSession, pickCreatorDirectory, relocateSessionContent, restoreSessionContent, startContentSession, type CreatorWorkbenchService } from "../src/client/workbench.ts";
import { CREATOR_STORAGE_KEY, DEFAULT_UI_STATE, loadCreatorUiState, saveCreatorUiState } from "../src/client/persistence.ts";

const content = { id: "episode", folderPath: "/library/episode" };
let storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
function host() {
  const owned = new Set<string>();
  let current: string | undefined;
  let active = true;
  const ensureSession = vi.fn(async ({ sessionId }: { folder: string; sessionId?: string }) => {
    current = sessionId ?? "creator-session";
    owned.add(current);
    return current;
  });
  const service: CreatorWorkbenchService = {
    register: () => () => undefined, subscribe: () => () => undefined,
    currentSession: () => current, isActive: () => active, ownsSession: (id) => owned.has(id), ensureSession,
  };
  return { service, ensureSession, owned, setCurrent: (id: string) => { current = id; }, leave: () => { active = false; } };
}
beforeEach(() => {
  const values = new Map<string, string>();
  storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  vi.stubGlobal("localStorage", storage);
  saveCreatorUiState(storage, { ...DEFAULT_UI_STATE, selectedId: content.id });
});
afterEach(() => vi.unstubAllGlobals());

describe("Desktop directory picker", () => {
  it("uses the same preload bridge as the official native directory flow", async () => {
    const pick = vi.fn(async () => "/confirmed");
    vi.stubGlobal("__DSH_DIRECTORY_PICKER__", { pick });
    const get = vi.fn(() => ({ pickDirectory: vi.fn(async () => null) }));
    await expect(pickCreatorDirectory({ get })).resolves.toBe("/confirmed");
    expect(get).not.toHaveBeenCalled();
    expect(pick).toHaveBeenCalledOnce();
  });
  it("retains the public workspace RPC fallback without a Desktop bridge", async () => {
    const pickDirectory = vi.fn(async () => null);
    await expect(pickCreatorDirectory({ get: () => ({ pickDirectory }) })).resolves.toBeNull();
    expect(pickDirectory).toHaveBeenCalledOnce();
  });
});

describe("content-owned sessions", () => {
  it("does not create a workspace, session, or mapping after cancellation", async () => {
    const { service, ensureSession } = host();
    const before = storage.getItem(CREATOR_STORAGE_KEY);
    expect(await startContentSession(service, content, async () => null)).toBeNull();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(storage.getItem(CREATOR_STORAGE_KEY)).toBe(before);
  });
  it("rejects an unrelated directory and preserves the selected content", async () => {
    const { service, ensureSession } = host();
    await expect(startContentSession(service, content, async () => "/other")).rejects.toThrow("这一期");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(loadCreatorUiState(storage).selectedId).toBe(content.id);
  });
  it("creates its own session rather than adopting a native or foreign saved id", async () => {
    const { service, ensureSession, setCurrent } = host();
    setCurrent("native");
    saveCreatorUiState(storage, { ...DEFAULT_UI_STATE, selectedId: content.id, sessionContents: {
      native: { contentId: content.id, folder: content.folderPath },
    } });
    expect(await startContentSession(service, content, async () => content.folderPath + "/")).toBe("creator-session");
    expect(ensureSession).toHaveBeenCalledWith({ folder: content.folderPath });
    expect(loadCreatorUiState(storage).selectedId).toBe(content.id);
    expect(contentForSession(service)).toBe(content.id);
  });
  it("restores an owned mapping and keeps different sessions' business selections distinct", async () => {
    const { service, ensureSession, owned, setCurrent } = host();
    owned.add("saved");
    owned.add("second");
    saveCreatorUiState(storage, { ...DEFAULT_UI_STATE, selectedId: "recent", sessionContents: {
      saved: { contentId: content.id, folder: content.folderPath },
      second: { contentId: "other-content", folder: "/other" },
    } });
    const picker = vi.fn(async () => null);
    expect(await startContentSession(service, content, picker)).toBe("saved");
    expect(picker).not.toHaveBeenCalled();
    expect(ensureSession).toHaveBeenCalledWith({ folder: content.folderPath, sessionId: "saved" });
    setCurrent("second"); expect(contentForSession(service)).toBe("other-content");
    setCurrent("native"); expect(contentForSession(service)).toBeNull();
  });
  it("does not finish a new session action after leaving the workbench during selection", async () => {
    const { service, ensureSession, leave } = host();
    expect(await startContentSession(service, content, async () => { leave(); return content.folderPath; })).toBeNull();
    expect(ensureSession).not.toHaveBeenCalled();
  });
  it("keeps a recoverable session when storage fails, so a retry does not duplicate it", async () => {
    const { service, ensureSession } = host();
    const original = storage.setItem;
    storage.setItem = () => { throw new Error("quota"); };
    await expect(startContentSession(service, content, async () => content.folderPath)).rejects.toThrow("关联未保存");
    storage.setItem = original;
    expect(await startContentSession(service, content, async () => null)).toBe("creator-session");
    expect(ensureSession.mock.calls[1]?.[0]).toHaveProperty("sessionId", "creator-session");
  });
  it("restores the confirmed library before reading a repeated content id", async () => {
    const { service, owned, setCurrent } = host();
    owned.add("saved"); setCurrent("saved");
    saveCreatorUiState(storage, { ...DEFAULT_UI_STATE, sessionContents: {
      saved: { contentId: "same-id", folder: "/library-a/same-id" },
    } });
    let currentRoot = "/library-b";
    const reads: string[] = [];
    expect(await restoreSessionContent(service, {
      setLibraryRoot: async (root) => { currentRoot = root; },
      getContent: async (id) => { const folderPath = `${currentRoot}/${id}`; reads.push(folderPath); return { folderPath }; },
    })).toBe("same-id");
    expect(reads).toEqual(["/library-a/same-id"]);
  });
  it("fails visibly when a confirmed location is missing, without silently creating or rebinding it", async () => {
    const { service, owned, setCurrent, ensureSession } = host();
    owned.add("saved"); setCurrent("saved");
    saveCreatorUiState(storage, { ...DEFAULT_UI_STATE, sessionContents: {
      saved: { contentId: content.id, folder: content.folderPath },
    } });
    await expect(restoreSessionContent(service, {
      setLibraryRoot: async () => { throw new Error("directory missing"); },
      getContent: async () => ({ folderPath: content.folderPath }),
    })).rejects.toThrow("directory missing");
    expect(ensureSession).not.toHaveBeenCalled();
    expect(contentForSession(service)).toBe(content.id);
  });

  it("persists a relocated content link without reusing the old workspace's session", async () => {
    const { service, owned, setCurrent, ensureSession } = host();
    owned.add("old"); setCurrent("old");
    const relocated = { id: "episode", folderPath: "/new-library/episode" };
    await expect(relocateSessionContent(service, relocated.folderPath, {
      setLibraryRoot: async () => undefined,
      getContent: async () => ({ folderPath: relocated.folderPath }),
    })).resolves.toBe(relocated.id);
    expect(loadCreatorUiState(storage).sessionContents?.old).toEqual({
      contentId: relocated.id, folder: relocated.folderPath, requiresNewSession: true,
    });
    expect(await restoreSessionContent(service, {
      setLibraryRoot: async () => undefined, getContent: async () => ({ folderPath: relocated.folderPath }),
    })).toBe(relocated.id);
    expect(await startContentSession(service, relocated, async () => relocated.folderPath)).toBe("creator-session");
    expect(ensureSession).toHaveBeenCalledWith({ folder: relocated.folderPath });
  });

  it("invalidates an operation started before the native directory picker or a list refresh when the session changes", () => {
    const { service, owned, setCurrent } = host();
    owned.add("first"); owned.add("second"); setCurrent("first");
    const current = captureWorkbenchNavigation(service);
    expect(current()).toBe(true);
    setCurrent("second");
    expect(current()).toBe(false);
  });

});
