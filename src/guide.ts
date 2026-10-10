import { PUBLISH_PLATFORM_DEFINITIONS } from "./platforms.ts";
import type { CreatorCapability, CreatorSetupStatus, PublishPlatform } from "./types.ts";

function stateMark(capability: CreatorCapability): string {
  if (capability.state === "ready") return "可用";
  if (capability.state === "unsupported") return "当前系统不支持";
  return "缺失";
}

function capabilityLine(label: string, capability: CreatorCapability): string {
  return `- ${label}：${stateMark(capability)}。${capability.detail}`;
}

function subtitleLines(capabilities: CreatorSetupStatus["capabilities"]): string[] {
  const lines: string[] = [];
  if (capabilities.subtitleSkill.state !== "ready") {
    const installedPath = capabilities.subtitleSkill.path;
    const needsSetup = capabilities.subtitleSkill.detail.includes("尚未完成 setup.sh");
    lines.push(
      needsSetup && installedPath !== undefined
        ? `- oil-subtitle 已下载但未初始化：征得用户同意后执行 \`bash "${installedPath}/setup.sh"\`，完成后重新调用 oil_creator_setup 确认。`
        : installedPath === undefined
          ? "- 缺 oil-subtitle：征得用户同意后执行 `git clone https://github.com/oil-oil/oil-subtitle ~/.agents/skills/oil-subtitle && bash ~/.agents/skills/oil-subtitle/setup.sh`，装完重新调用 oil_creator_setup 确认。"
          : `- 缺 oil-subtitle：征得用户同意后按能力状态中给出的命令安装到当前配置目录 \`${installedPath}\`，装完重新调用 oil_creator_setup 确认。`,
    );
  }
  if (capabilities.subtitleCredential.state !== "ready") {
    lines.push("- 缺 DASHSCOPE_API_KEY：让用户到百炼控制台（https://bailian.console.aliyun.com）申请，在 设置 → 插件 → 内容工作台 填写；不要让用户把 Key 明文发到对话里。");
  }
  return lines.length === 0 ? ["- 当前字幕能力可用。"] : lines;
}

function coverLines(capabilities: CreatorSetupStatus["capabilities"]): string[] {
  const lines: string[] = [];
  if (capabilities.coverSkill.state !== "ready") {
    lines.push("- 缺 oil-cover：征得用户同意后执行 `git clone https://github.com/oil-oil/oil-cover ~/.agents/skills/oil-cover`，装完重新调用 oil_creator_setup 确认。");
  }
  if (capabilities.coverCredential.state !== "ready") {
    lines.push("- 缺 ZENMUX_API_KEY：让用户到 ZenMux（https://zenmux.ai）控制台申请，在 设置 → 插件 → 内容工作台 填写；不要让用户把 Key 明文发到对话里。");
  }
  return lines.length === 0 ? ["- 当前封面能力可用。"] : lines;
}

function publishPlatformLine(enabledPlatforms: readonly PublishPlatform[]): string {
  if (enabledPlatforms.length === 0) {
    return "- 当前 enabledPlatforms 为空（[]）：不要调用 video-publisher，也不要调用 oil_sync_publish；先用 oil_creator_setup 配置启用平台，用户确认后再继续。";
  }
  const names = enabledPlatforms
    .map((platform) => `${PUBLISH_PLATFORM_DEFINITIONS[platform].name}（${platform}）`)
    .join("、");
  return `- 当前 enabledPlatforms：${names}。video-publisher 与 oil_sync_publish 只处理这些平台，不得上传或同步其他平台。`;
}

/**
 * Build the self-bootstrap guide for the model. The text reflects the live
 * capability status so the model can tell the user exactly which parts of the
 * workflow work on this machine and which need installation or credentials.
 */
export function creatorGuideText(status: CreatorSetupStatus): string {
  const { capabilities, settings } = status;
  const scriptRules = settings.scriptRules;
  const enabledPlatforms = settings.profile.enabledPlatforms;
  const lines: string[] = [
    "# 内容工作台自举指引",
    "",
    "用户在 DeepSeek Harness 里安装了内容工作台插件。你的任务是带用户把一条片子从选题推进到发布，并在能力缺失时明确告诉用户缺什么、怎么补。先把下面的现状转成用户听得懂的话，不要逐字复述。",
    "",
    "## 当前能力状态",
    capabilityLine("内容目录（核心）", capabilities.library),
    capabilityLine("Screen Studio 工程", capabilities.screenStudio),
    capabilityLine("字幕工作流 oil-subtitle", capabilities.subtitleSkill),
    capabilityLine("字幕凭据 DASHSCOPE_API_KEY", capabilities.subtitleCredential),
    capabilityLine("封面工作流 oil-cover", capabilities.coverSkill),
    capabilityLine("封面凭据 ZENMUX_API_KEY", capabilities.coverCredential),
    capabilityLine("Ego Browser（自动发布与数据回收）", capabilities.publishSync),
    capabilityLine("剪辑 skill screen-studio-editor", capabilities.editingSkill),
    capabilityLine("发布 skill video-publisher", capabilities.publishSkill),
    capabilityLine("公众号 skill oil-video-article", capabilities.articleSkill),
    "",
    "## 内容管理",
    `- 片库目录是 ${settings.libraryRoot}，一集一个子文件夹，命名为 YYYY-MM-DD_可读标题。`,
    "- 正文以磁盘文件为准：topic.md 选题、script.md 口播脚本、公众号文章/ 图文稿、*.mp4 成片、*.srt/*.ass 字幕、*_3x4.png 等封面。读和改这些文件用系统自带的文件工具。",
    "- 新建一集用 oil_create_content；文件夹名乱了用 oil_organize_library，先预览、用户确认后再 apply=true。它只改名，不删文件。",
    "- 工作台自己的状态（绑定、阶段、发布标记）在 overlay.json，不是正文，不要手改。",
    "",
    "## 脚本与人设",
    "- 每集的口播脚本在 script.md，直接用文件工具读写。",
    scriptRules === undefined
      ? "- 当前没有配置脚本规则（人设）。用户第一次让你写或改脚本时，先主动问清语气、结构、禁忌和目标观众，再用 oil_script_rules 存下来，之后每次写脚本都遵循。"
      : "- 已配置脚本规则（人设），写或改 script.md 前先用 oil_script_rules 读取并严格遵循；用户提出新的长期偏好时，把它合并进规则再保存。",
    "",
    "## 字幕",
    "- 成片落盘后：oil_generate_subtitles 转录、自动校对、排版，完成后打开预览；用户在预览里确认专有名词后，再用 oil_burn_subtitles 烧录。预览前不要烧录。",
    "- oil_generate_subtitles 是 Harness 后台任务。保存返回的 job id，用 job_output 的 wait=true 等待并获取完成结果、job_kill 取消；不要把启动说成完成。完成标志是 subtitle-transcript.json / subtitle-manifest.json，不是 *_subtitled.mp4。",
    ...subtitleLines(capabilities),
    "",
    "## 封面",
    "- oil_generate_cover 前先按 oil-cover 从脚本或字幕提炼封面主标题，通过 title 传入；不要把文件夹名直接当封面结论。它返回 Harness job id，用 job_output（需要等待时传 wait=true）/ job_kill 管理。",
    "- 封面任务完成后调用 oil_prepare_visual_review，把三画幅作为图片附件检查构图、可读性、安全区、画幅适配和品牌一致性；随后调用 oil_save_visual_review，把具体结论写入该期目录。",
    ...coverLines(capabilities),
    "",
    "## 录制与剪辑",
    "- Screen Studio 是录制和自动剪辑的共同前提（仅 macOS）：录制和导出成片由用户在 Screen Studio 里亲手完成；剪辑走外部 skill screen-studio-editor，它操作的是 .screenstudio 工程。",
    capabilities.screenStudio.state === "ready"
      ? "- 当前已发现 Screen Studio。用 oil_update_content 把工程绑到对应一集，oil_open_studio 打开，oil_wait_export 以 Harness 后台任务等待成片落盘。"
      : "- 当前没有可用的 Screen Studio：绑定工程、自动剪辑（screen-studio-editor）和等待导出都不可用。告诉用户需要先装 Screen Studio 并用它录制；如果用户用其他工具剪片，把成片文件放进这一集的文件夹即可跳过这一环节。",
    capabilities.editingSkill.state === "ready"
      ? "- 已发现 screen-studio-editor，用户要求清理时间线时直接使用。"
      : "- 缺 screen-studio-editor：征得用户同意后执行 `git clone https://github.com/oil-oil/screen-studio-editor ~/.agents/skills/screen-studio-editor`；没有它时剪辑由用户自己完成。",
    "",
    "## 自动发布与数据回收",
    "- 这两项都依赖 Ego Browser（PATH 里的 ego-browser 命令）和已登录的各平台创作者后台。",
    publishPlatformLine(enabledPlatforms),
    capabilities.publishSync.state === "ready"
      ? enabledPlatforms.length === 0
        ? "- 已发现 Ego Browser，但当前没有启用平台，不执行自动发布和数据回收。"
        : "- 当前已发现 Ego Browser。上传发布走外部 skill video-publisher，停在最终发表按钮前由用户点；发布后或用户要求时用 oil_sync_publish 回收播放、赞、评论并写回工作台。"
      : "- 当前未发现 Ego Browser：自动发布和 oil_sync_publish 数据回收都不可用。告诉用户到 https://lite.ego.app 下载 ego lite，完成首次引导后 ego-browser 命令可用，再登录各平台创作者后台；片库、脚本、字幕、封面不受影响，不要假装能同步。",
    capabilities.publishSkill.state === "ready"
      ? enabledPlatforms.length === 0
        ? "- 已发现 video-publisher，但当前没有启用平台，不使用它。"
        : "- 已发现 video-publisher。"
      : enabledPlatforms.length === 0
        ? "- 当前没有启用平台，先配置 enabledPlatforms，再考虑安装 video-publisher。"
        : "- 缺 video-publisher：征得用户同意后执行 `git clone https://github.com/oil-oil/video-publisher-skill ~/.agents/skills/video-publisher`；没有它时在插件里手动标记发布状态即可。",
    "",
    "## 公众号图文",
    "- 把一期视频转成公众号文章走外部 skill oil-video-article，产物在这一集的 公众号文章/ 目录，插件负责展示，不负责生成。",
    "- 输入不绑死 Screen Studio：有 .screenstudio 工程时从无头像的屏幕轨道截帧，效果最好；只有普通成片视频时也能转写，配图直接从成片截取。",
    "- 文章语气遵循 oil-tone skill；公众号不是第五个视频平台，不参与发布状态标记。",
    capabilities.articleSkill.state === "ready"
      ? "- 已发现 oil-video-article，用户提到把视频整理成文章时直接使用。"
      : "- 缺 oil-video-article：征得用户同意后执行 `git clone https://github.com/oil-oil/oil-video-article ~/.agents/skills/oil-video-article`；不需要公众号时可以跳过这一环节。",
    "",
    "## 推进原则",
    "- 每次只推进当前缺失的下一步：选题与脚本 → 录制 → 导出成片 → 字幕 → 封面 → 发布 → 数据回收。",
    "- 任何写入（配置、整理、发布标记）先预览或说明，用户确认后再执行。",
    ...(
      status.recommendations.length === 0
        ? ["- 当前没有待办的环境建议。"]
        : ["", "## 环境建议", ...status.recommendations.map((item) => `- ${item}`)]
    ),
  ];
  return lines.join("\n");
}
