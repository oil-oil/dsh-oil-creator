import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isPublishSyncDisabled,
  selectEnabledPublishPlatforms,
} from "../src/client/publishPlatforms.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("content inspector enabled platform contract", () => {
  it("filters platform definitions through enabledPlatforms", () => {
    expect(selectEnabledPublishPlatforms(["wechat", "douyin"]).map((platform) => platform.key))
      .toEqual(["douyin", "wechat"]);
    expect(selectEnabledPublishPlatforms([])).toEqual([]);
  });

  it("disables sync while settings load, while busy, or with no enabled platform", () => {
    expect(isPublishSyncDisabled(undefined, true, ["wechat"])).toBe(true);
    expect(isPublishSyncDisabled("sync", false, ["wechat"])).toBe(true);
    expect(isPublishSyncDisabled(undefined, false, [])).toBe(true);
    expect(isPublishSyncDisabled(undefined, false, ["wechat"])).toBe(false);
  });

  it("connects tabs and panels and supports roving keyboard focus", () => {
    const source = readFileSync(resolve(root, "src/client/ContentInspector.tsx"), "utf8");
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain("aria-controls");
    expect(source).toContain("aria-labelledby");
    expect(source).toContain("tabIndex={tab === id ? 0 : -1}");
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).toContain('event.key === "ArrowLeft"');
  });
});
