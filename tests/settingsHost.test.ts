import { describe, expect, it, vi } from "vitest";
import { registerCreatorSettingsNamespace } from "../src/settingsHost.ts";
describe("creator settings presentation", () => {
  it("uses entry-derived forms and releases its custom page policy", () => {
    const release = vi.fn();
    const configure = vi.fn(() => release);
    expect(registerCreatorSettingsNamespace({ configure })).toBe(release);
    expect(configure).toHaveBeenCalledWith({ auto: false });
  });
});
