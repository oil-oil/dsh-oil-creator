import type { ComponentType } from "react";
import { browserCreatorStorage, loadCreatorUiState, saveCreatorUiState } from "./persistence.ts";

export const CREATOR_REPOSITORY = "oil-oil/dsh-oil-creator";

/** DSH Desktop 0.11.0's installed workbench provider contract. */
export interface CreatorWorkbenchService {
  register: (descriptor: {
    title: string;
    repository: string;
    description: string;
    panelTitle: string;
    layout: { businessSide: "right"; businessWidth: number };
  }, panel: ComponentType) => () => void;
  subscribe: (listener: () => void) => () => void;
  currentSession: () => string | undefined;
  ownsSession: (sessionId: string) => boolean;
  isActive: () => boolean;
  ensureSession: (request: { folder: string; sessionId?: string }) => Promise<string>;
}

interface Services { get: (name: string) => unknown }
export function desktopWorkbenchesOf(ctx: Services): CreatorWorkbenchService {
  const service = ctx.get("desktopWorkbenches") as CreatorWorkbenchService | undefined;
  if (service === undefined) throw new Error("请使用提供工作台服务的 DSH Desktop 打开内容工作台。");
  return service;
}

export function captureWorkbenchNavigation(service: CreatorWorkbenchService): () => boolean {
  const session = service.currentSession();
  return () => service.isActive() && service.currentSession() === session;
}

export function pickCreatorDirectory(ctx: Services): Promise<string | null> {
  // Match Desktop's official native directory-flow provider: its preload
  // bridge shows an Electron dialog, while the Host RPC uses an OS subprocess.
  const desktop = (globalThis as typeof globalThis & {
    __DSH_DIRECTORY_PICKER__?: { pick: () => Promise<string | null> };
  }).__DSH_DIRECTORY_PICKER__;
  if (desktop !== undefined) return desktop.pick();
  const navigation = ctx.get("uiWorkspace") as { pickDirectory: () => Promise<string | null> };
  return navigation.pickDirectory();
}
const recentBindings = new WeakMap<CreatorWorkbenchService, Map<string, { contentId: string; folder: string; requiresNewSession?: boolean }>>();

/** Never adopt a native or another workbench's saved session. No auto-send. */
export async function startContentSession(
  service: CreatorWorkbenchService,
  content: { id: string; folderPath: string },
  pickDirectory: () => Promise<string | null>,
): Promise<string | null> {
  const state = loadCreatorUiState(browserCreatorStorage());
  const saved = Object.entries({ ...state.sessionContents, ...Object.fromEntries(recentBindings.get(service) ?? []) }).find(([id, item]) =>
    item.requiresNewSession !== true && item.contentId === content.id && item.folder === content.folderPath && service.ownsSession(id));
  let folder = content.folderPath;
  if (saved === undefined) {
    const selected = await pickDirectory();
    if (selected === null || !service.isActive()) return null;
    // Business content must stay in its existing folder; do not silently switch
    // to the most recent workspace or a directory inferred from the repository.
    if (selected.replace(/[\\/]+$/, "") !== folder.replace(/[\\/]+$/, "")) {
      throw new Error(`请在目录选择器中选择这一期的资料目录：${folder}`);
    }
    // Keep the catalog path as the stable identity even if the picker returns a trailing slash.
  }
  if (!service.isActive()) return null;
  const sessionId = await service.ensureSession({ folder, ...(saved ? { sessionId: saved[0] } : {}) });
  if (!service.ownsSession(sessionId)) return null;
  const pending = recentBindings.get(service) ?? new Map();
  pending.set(sessionId, { contentId: content.id, folder });
  recentBindings.set(service, pending);
  const latest = loadCreatorUiState(browserCreatorStorage());
  if (!saveCreatorUiState(browserCreatorStorage(), {
    ...latest,
    sessionContents: { ...latest.sessionContents, [sessionId]: { contentId: content.id, folder } },
  })) throw new Error("会话已创建，但内容关联未保存。请保留当前内容并重试。");
  return service.isActive() && service.currentSession() === sessionId ? sessionId : null;
}

export function contentBindingForSession(service: CreatorWorkbenchService): { contentId: string; folder: string } | null {
  const session = service.currentSession();
  if (session === undefined || !service.ownsSession(session)) return null;
  return recentBindings.get(service)?.get(session)
    ?? loadCreatorUiState(browserCreatorStorage()).sessionContents?.[session] ?? null;
}

export function contentForSession(service: CreatorWorkbenchService): string | null {
  return contentBindingForSession(service)?.contentId ?? null;
}

export function libraryRootForFolder(folder: string): string {
  const clean = folder.replace(/[\\/]+$/, "");
  if (!clean.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(clean)) throw new Error("资料目录必须是绝对路径。");
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return cut === 0 ? "/" : cut === 2 && clean[1] === ":" ? clean.slice(0, 3) : clean.slice(0, cut);
}

/** Restore the confirmed folder as well as the id; ids can repeat in different libraries. */
export async function restoreSessionContent(service: CreatorWorkbenchService, face: {
  setLibraryRoot: (root: string) => Promise<void>;
  getContent: (id: string) => Promise<{ folderPath: string }>;
}): Promise<string | null> {
  const session = service.currentSession();
  const binding = contentBindingForSession(service);
  if (binding === null || !service.isActive()) return null;
  const current = () => service.isActive() && service.currentSession() === session;
  await face.setLibraryRoot(libraryRootForFolder(binding.folder));
  if (!current()) return null;
  const detail = await face.getContent(binding.contentId);
  if (detail.folderPath !== binding.folder) throw new Error("资料位置已改变，请重新选择资料目录。");
  return current() ? binding.contentId : null;
}

/** Relocate business data explicitly without changing the old session's host-owned workspace. */
export async function relocateSessionContent(service: CreatorWorkbenchService, folder: string, face: {
  setLibraryRoot: (root: string) => Promise<void>;
  getContent: (id: string) => Promise<{ folderPath: string }>;
}): Promise<string | null> {
  const session = service.currentSession();
  if (session === undefined || !service.ownsSession(session) || !service.isActive()) return null;
  const root = libraryRootForFolder(folder);
  const clean = folder.replace(/[\\/]+$/, "");
  const id = clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1);
  await face.setLibraryRoot(root);
  if (!service.isActive() || service.currentSession() !== session) return null;
  const detail = await face.getContent(id);
  if (detail.folderPath !== clean) throw new Error("请选择包含这一期资料的内容文件夹。");
  if (!service.isActive() || service.currentSession() !== session) return null;
  const binding = { contentId: id, folder: detail.folderPath, requiresNewSession: true };
  const pending = recentBindings.get(service) ?? new Map();
  pending.set(session, binding); recentBindings.set(service, pending);
  const state = loadCreatorUiState(browserCreatorStorage());
  if (!saveCreatorUiState(browserCreatorStorage(), { ...state, sessionContents: { ...state.sessionContents, [session]: binding } })) {
    throw new Error("新资料关联未保存，请保留当前选择并重试。");
  }
  return id;
}
