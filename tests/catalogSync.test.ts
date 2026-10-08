import { afterEach, describe, expect, it, vi } from "vitest";

import { startLibraryLiveSync } from "../src/client/catalogSync.ts";
import {
  getLibraryEpoch,
  setSelectedContentId,
  subscribeLibrary,
} from "../src/client/contentSelection.ts";

describe("startLibraryLiveSync", () => {
  afterEach(() => {
    setSelectedContentId(null);
    vi.useRealTimers();
  });

  it("bumps the library epoch only after the host revision moves", async () => {
    vi.useFakeTimers();
    let revision = 0;
    const seen: number[] = [];
    const start = getLibraryEpoch();
    const stopListen = subscribeLibrary(() => {
      seen.push(getLibraryEpoch());
    });
    const stop = startLibraryLiveSync(async () => revision, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(seen).toEqual([]);

    revision = 3;
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.at(-1)).toBe(start + 1);

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(seen).toEqual([start + 1]);

    stop();
    stopListen();
  });
});
