import { describe, expect, it } from "vitest";

import { OIL_CREATOR_INVOCATIONS, PACKAGE_NAME, REMOTE_NAMESPACE } from "../src/remote-contract.ts";
import { TYPERT } from "../src/typert.host.ts";

describe("handwritten TYPERT", () => {
  it("matches the package and host face", () => {
    expect(TYPERT.package).toBe(PACKAGE_NAME);
    expect(TYPERT.face).toBe("host");
    expect(TYPERT.invocations).toBe(OIL_CREATOR_INVOCATIONS);
  });

  it("exposes oilCreator methods with zod v4 codecs", () => {
    const methods = OIL_CREATOR_INVOCATIONS.map((item) => item.method);
    expect(methods).toEqual([
      "listContents",
      "getContent",
      "getCoverThumb",
      "getVideoPlayback",
      "getArticleMedia",
      "getSubtitleText",
      "openContentPath",
      "getSettings",
      "getCapabilities",
      "getRevision",
      "setLibraryRoot",
      "refreshCatalog",
      "createContent",
      "setContentStage",
      "setProfile",
      "setScriptRules",
      "bindStudio",
      "openStudio",
      "setPublish",
      "syncPublish",
      "setScript",
      "openSubtitlePreview",
      "startSubtitleBurn",
      "startSubtitleGenerate",
      "startCoverGenerate",
    ]);
    for (const item of OIL_CREATOR_INVOCATIONS) {
      expect(item.service).toBe(REMOTE_NAMESPACE);
      expect(item.namespace).toBe(REMOTE_NAMESPACE);
      expect(item.result.mode).toBe("strict");
      if (item.result.mode !== "strict") continue;
      expect("_zod" in item.result.create()).toBe(true);
      expect(typeof item.result.create().parse).toBe("function");
    }
  });
});
