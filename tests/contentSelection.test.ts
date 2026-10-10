import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bumpLibrary,
  bumpProfile,
  getLibraryEpoch,
  getProfileEpoch,
  getSelectedContentId,
  inspectorIsOpen,
  setSelectedContentId,
  subscribeLibrary,
  subscribeProfile,
  subscribeSelectedContentId,
} from "../src/client/contentSelection.ts";

describe("content selection", () => {
  afterEach(() => {
    setSelectedContentId(null);
    vi.unstubAllGlobals();
  });

  it("notifies subscribers and persists", () => {
    const seen: Array<string | null> = [];
    const stop = subscribeSelectedContentId(() => {
      seen.push(getSelectedContentId());
    });
    setSelectedContentId("2026-01-23_demo");
    setSelectedContentId("2026-01-23_demo");
    expect(seen).toEqual(["2026-01-23_demo"]);
    expect(getSelectedContentId()).toBe("2026-01-23_demo");
    stop();
  });

  it("bumps the library epoch", () => {
    const start = getLibraryEpoch();
    let seen = start;
    const stop = subscribeLibrary(() => {
      seen = getLibraryEpoch();
    });
    bumpLibrary();
    expect(seen).toBe(start + 1);
    stop();
  });

  it("keeps profile refreshes separate from library refreshes", () => {
    const profileStart = getProfileEpoch();
    let profileSeen = profileStart;
    const stop = subscribeProfile(() => {
      profileSeen = getProfileEpoch();
    });

    bumpLibrary();
    expect(profileSeen).toBe(profileStart);
    bumpProfile();
    expect(profileSeen).toBe(profileStart + 1);
    stop();
  });

  it("does not mutate host layout when closing a selection", () => {
    const querySelector = vi.fn(() => { throw new Error("host DOM is private"); });
    vi.stubGlobal("document", { querySelector });
    setSelectedContentId("demo");
    expect(inspectorIsOpen()).toBe(true);
    setSelectedContentId(null);
    expect(inspectorIsOpen()).toBe(false);
    expect(querySelector).not.toHaveBeenCalled();
  });
});
