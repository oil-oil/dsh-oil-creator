import { describe, expect, it } from "vitest";

import {
  CREATOR_STORAGE_KEY,
  DEFAULT_UI_STATE,
  loadCreatorUiState,
  saveCreatorUiState,
  type CreatorStorage,
} from "../src/client/persistence.ts";

function memoryStorage(seed: Record<string, string> = {}): CreatorStorage {
  const data = { ...seed };
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("loadCreatorUiState", () => {
  it("returns defaults when storage is missing", () => {
    expect(loadCreatorUiState(undefined)).toEqual(DEFAULT_UI_STATE);
  });

  it("returns defaults for broken json", () => {
    expect(loadCreatorUiState(memoryStorage({ [CREATOR_STORAGE_KEY]: "{" }))).toEqual(
      DEFAULT_UI_STATE,
    );
  });

  it("keeps only known fields", () => {
    const storage = memoryStorage({
      [CREATOR_STORAGE_KEY]: JSON.stringify({
        schemaVersion: 1,
        selectedId: "2026-01-23_demo",
        filter: "cover",
        query: "harness",
        extra: true,
      }),
    });
    expect(loadCreatorUiState(storage)).toEqual({
      schemaVersion: 1,
      selectedId: "2026-01-23_demo",
      filter: "cover",
      query: "harness",
      sidebarTab: "sessions",
    });
  });

  it("keeps a saved sidebar tab", () => {
    const storage = memoryStorage({
      [CREATOR_STORAGE_KEY]: JSON.stringify({
        schemaVersion: 1,
        selectedId: null,
        filter: "all",
        query: "",
        sidebarTab: "content",
      }),
    });
    expect(loadCreatorUiState(storage).sidebarTab).toBe("content");
  });

  it("falls back when filter is unknown", () => {
    const storage = memoryStorage({
      [CREATOR_STORAGE_KEY]: JSON.stringify({
        selectedId: 1,
        filter: "published",
        query: null,
      }),
    });
    expect(loadCreatorUiState(storage)).toEqual(DEFAULT_UI_STATE);
  });
});
describe("saveCreatorUiState", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    const state = {
      schemaVersion: 1 as const,
      selectedId: "demo",
      filter: "subtitle" as const,
      query: "油",
      sidebarTab: "content" as const,
    };
    expect(saveCreatorUiState(storage, state)).toBe(true);
    expect(loadCreatorUiState(storage)).toEqual(state);
  });
});
