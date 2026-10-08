import { PUBLISH_PLATFORM_DEFINITIONS, type PublishPlatform } from "./platforms.ts";

export interface LibraryPromptSource {
  libraryRoot: string;
  dataDir: string;
  cache?: { libraryRoot: string } | undefined;
  cachedScriptRules?: string | undefined;
  cachedEnabledPlatforms?: readonly string[] | undefined;
}

export function resolvePromptLibraryRoot(source: LibraryPromptSource): string {
  return source.cache?.libraryRoot ?? source.libraryRoot;
}

function enabledPlatformNames(platforms: readonly string[]): string {
  return platforms.map((key) => {
    if (Object.hasOwn(PUBLISH_PLATFORM_DEFINITIONS, key)) {
      return PUBLISH_PLATFORM_DEFINITIONS[key as PublishPlatform].name;
    }
    return key;
  }).join("、");
}

export function libraryConventionText(
  libraryRoot: string,
  dataDir: string,
  scriptRules?: string,
  enabledPlatforms?: readonly string[],
): string {
  const lines = [
    `创作者的视频内容以磁盘文件为准，目录是 ${libraryRoot}。首次使用或能力不明确时先调用 oil_creator_setup 做只读检查；用户问这个插件能做什么、怎么用，或你不确定下一步时，调用 oil_creator_guide 获取带当前能力状态的完整指引。`,
    "一集一个子文件夹，名字是 YYYY-MM-DD_可读标题。列出这个目录就是片库；打开一集先列出那个文件夹，再读需要的文件。",
    "约定文件：topic.md 选题；script.md 口播脚本；公众号文章/<标题>.md 已转写文章，配图在 公众号文章/images/；publish-package.json 只放标题和 tags，不写平台长文案；*.mp4/*.mov 成片（_subtitled 为烧录版）；*.srt/*.ass 字幕；*_3x4.png *_4x3.png *_16x9.png 封面。",
    "读或改这些内容，用系统自带的列文件、读文件、写文件工具。不要为了看一集再调插件工具。",
    "写或改 script.md 必须遵循用户的脚本规则（人设）：先用 oil_script_rules 读取；还没配置时主动问清语气、结构和禁忌，再用 oil_script_rules 存下来。",
    `插件工具只做文件做不到的事：配置工作台、按约定建文件夹、绑/开 Screen Studio、等导出、生成或烧录字幕、生成封面、同步已发布数据、整理文件夹名。工作台状态在 ${dataDir}/overlay.json，不是正文。`,
    "自动发布（video-publisher skill）和已发布数据回收（oil_sync_publish）都依赖 Ego Browser；能力检查显示缺失时明确告诉用户，不要假装能同步。",
  ];
  if (enabledPlatforms !== undefined) {
    lines.push(
      enabledPlatforms.length === 0
        ? "当前没有启用发布平台。不要调用 video-publisher 或 oil_sync_publish。"
        : `当前启用平台：${enabledPlatformNames(enabledPlatforms)}。video-publisher 和 oil_sync_publish 只处理这些平台。`,
    );
  }
  if (scriptRules !== undefined && scriptRules.trim() !== "") {
    lines.push("", "当前脚本规则（人设）：", scriptRules.trim());
  }
  return lines.join("\n");
}

export interface LibraryPromptHost {
  get: (name: string) => unknown;
  on: (event: "system-prompt/assemble", listener: (
    assembly: { sections: Array<{ name: string; text: string }> },
    context: { agent?: { session: { id: string } } },
    next: () => Promise<unknown>,
  ) => Promise<unknown>) => () => void;
}

/** Read Desktop's durable ownership for every assembly; native sessions receive no private library context. */
export function registerLibraryPrompt(ctx: LibraryPromptHost, source: LibraryPromptSource): () => void {
  return ctx.on("system-prompt/assemble", async (assembly, context, next) => {
    const id = context.agent?.session.id;
    const ownership = ctx.get("desktopWorkbenchOwnership") as {
      read: () => Promise<{ added: string[]; sessionBindings: Record<string, string> }>;
    } | undefined;
    const state = id === undefined || ownership === undefined ? undefined : await ownership.read().catch(() => undefined);
    if (id !== undefined && state?.added.includes("oil-oil/dsh-oil-creator")
      && state.sessionBindings[id] === "oil-oil/dsh-oil-creator") {
      assembly.sections.push({ name: "oil:library", text: libraryConventionText(
        resolvePromptLibraryRoot(source), source.dataDir, source.cachedScriptRules, source.cachedEnabledPlatforms,
      ) });
    }
    return next();
  });
}
