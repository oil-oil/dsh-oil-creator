import type { ContentFilter } from "../types.ts";

export const CREATOR_STORAGE_KEY = "dsh-oil-creator/ui/v1";

export type SidebarTab = "sessions" | "content";

export interface CreatorUiState {
  schemaVersion: 1;
  selectedId: string | null;
  filter: ContentFilter;
  query: string;
  sidebarTab: SidebarTab;
  inspectorWidth?: number;
  sessionContents?: Record<string, { contentId: string; folder: string; requiresNewSession?: boolean }>;
}
export const DEFAULT_UI_STATE: CreatorUiState = {
  schemaVersion: 1,
  selectedId: null,
  filter: "all",
  query: "",
  sidebarTab: "sessions",
};

export interface CreatorStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function browserCreatorStorage(): CreatorStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadCreatorUiState(storage: CreatorStorage | undefined): CreatorUiState {
  if (storage === undefined) return { ...DEFAULT_UI_STATE };
  try {
    const raw = storage.getItem(CREATOR_STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_UI_STATE };
    const parsed = JSON.parse(raw) as Partial<CreatorUiState>;
    const filter = parsed.filter;
    return {
      schemaVersion: 1,
      ...(parsed.sessionContents !== undefined ? { sessionContents: Object.fromEntries(Object.entries(parsed.sessionContents ?? {}).filter(([id, item]) =>
        id !== "" && item !== null && typeof item === "object" && typeof item.contentId === "string" && typeof item.folder === "string")) } : {}),
      selectedId: typeof parsed.selectedId === "string" ? parsed.selectedId : null,
      filter: filter === "cover" || filter === "subtitle" || filter === "article" ? filter : "all",
      query: typeof parsed.query === "string" ? parsed.query : "",
      sidebarTab: parsed.sidebarTab === "content" ? "content" : "sessions",
      ...(typeof parsed.inspectorWidth === "number" && Number.isFinite(parsed.inspectorWidth)
        ? { inspectorWidth: parsed.inspectorWidth }
        : {}),
    };
  } catch {
    return { ...DEFAULT_UI_STATE };
  }
}

export function saveCreatorUiState(
  storage: CreatorStorage | undefined,
  state: CreatorUiState,
): boolean {
  if (storage === undefined) return false;
  try {
    storage.setItem(CREATOR_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
