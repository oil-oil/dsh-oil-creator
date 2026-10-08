import { describe, expect, it } from "vitest";

import {
  libraryConventionText,
  registerLibraryPrompt,
  resolvePromptLibraryRoot,
} from "../src/libraryPrompt.ts";

describe("libraryConventionText", () => {
  it("names the library and tells the model to use file tools", () => {
    const text = libraryConventionText("/Movies/视频项目", "/.dsh-oil-creator");
    expect(text).toContain("/Movies/视频项目");
    expect(text).toContain("YYYY-MM-DD_可读标题");
    expect(text).toContain("script.md");
    expect(text).toContain("公众号文章/");
    expect(text).toContain("系统自带的列文件、读文件、写文件工具");
    expect(text).toContain("oil_creator_setup");
    expect(text).toContain("oil_creator_guide");
    expect(text).toContain("oil_script_rules");
    expect(text).toContain("Ego Browser");
    expect(text).toContain("/.dsh-oil-creator/overlay.json");
    expect(text).not.toContain("oil_get_content");
    expect(text).not.toContain("oil_list_contents");
    expect(text).not.toContain("当前启用平台");
  });

  it("names the enabled publish platforms", () => {
    const text = libraryConventionText("/Movies/视频项目", "/.dsh-oil-creator", undefined, ["douyin", "wechat"]);
    expect(text).toContain("当前启用平台：抖音、视频号");
    expect(libraryConventionText("/Movies/视频项目", "/.dsh-oil-creator", undefined, []))
      .toContain("当前没有启用发布平台");
  });

  it("appends the configured script rules", () => {
    const text = libraryConventionText("/Movies/视频项目", "/.dsh-oil-creator", " 口语化，少用术语。 ");
    expect(text).toContain("当前脚本规则（人设）：");
    expect(text).toContain("口语化，少用术语。");
    const without = libraryConventionText("/Movies/视频项目", "/.dsh-oil-creator", "   ");
    expect(without).not.toContain("当前脚本规则");
  });
});

describe("resolvePromptLibraryRoot", () => {
  it("prefers the scanned library root", () => {
    expect(resolvePromptLibraryRoot({
      libraryRoot: "/default",
      dataDir: "/data",
      cache: { libraryRoot: "/chosen" },
    })).toBe("/chosen");
  });
});

describe("registerLibraryPrompt", () => {
  it("attaches private content context only to an available creator-owned session", async () => {
    let listener: Parameters<Parameters<typeof registerLibraryPrompt>[0]["on"]>[1];
    const state = { added: ["oil-oil/dsh-oil-creator"], sessionBindings: { own: "oil-oil/dsh-oil-creator", other: "someone/other" } };
    registerLibraryPrompt({
      get: () => ({ read: async () => state }),
      on(_event, handle) { listener = handle; return () => undefined; },
    }, { libraryRoot: "/lib", dataDir: "/data" });
    for (const id of ["own", "other", "native", undefined]) {
      const assembly = { sections: [] as Array<{ name: string; text: string }> };
      await listener!(assembly, id === undefined ? {} : { agent: { session: { id } } }, async () => assembly);
      expect(assembly.sections).toEqual(id === "own" ? [{ name: "oil:library", text: libraryConventionText("/lib", "/data") }] : []);
    }
    state.added = [];
    const assembly = { sections: [] };
    await listener!(assembly, { agent: { session: { id: "own" } } }, async () => assembly);
    expect(assembly.sections).toEqual([]);
  });
});
