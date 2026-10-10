interface SkillsContext {
  skills: {
    register: (skill: {
      name: string;
      description: string;
      source: "runtime";
      content: string;
      invocation: { modelInvocable: boolean; userInvocable: boolean };
    }) => () => void;
  };
}

export const CREATOR_WORKBENCH_SKILL = {
  name: "creator-workbench",
  description:
    "配置和使用内容工作台。首次使用、调整内容目录、整理目录、检查字幕/封面/发布能力，或推进一条内容时使用。",
  source: "runtime" as const,
  invocation: { modelInvocable: true, userInvocable: true },
  content: `# 内容工作台

## 开始前

1. 用户不知道这个插件能做什么、怎么用，或你不确定下一步时，先调用 \`oil_creator_guide\`；它会返回带当前能力状态的完整指引。
2. 配置或诊断环境调用 \`oil_creator_setup\`，不要先向用户询问系统能够检查出来的信息。
3. 根据返回的 \`capabilities\` 区分核心能力和可选能力。内容目录是核心；Screen Studio、字幕、封面和发布同步缺失时只降级对应环节。
4. 如果需要寻找目录，先用系统文件工具只读查看候选目录。不要扫描整个磁盘，不要读取与内容工作无关的私人文件。

## 配置

- 内容目录和 \`enabledPlatforms\` 通过 \`oil_creator_setup\` 配置；这里不配置创作者名称或平台主页。
- 脚本规则（人设）通过 \`oil_script_rules\` 配置：写或改 script.md 前先读；用户第一次让你写脚本而没有规则时，主动问清语气、结构、禁忌和目标观众再存下；之后把新的长期偏好合并进现有规则，不要整体覆盖。
- 候选内容目录不存在时，让用户在内容工作台的系统目录选择器中明确新建或选择目录；用户确认后再重新调用 \`oil_creator_setup\` 预览。不要在默认位置或推测路径创建目录。
- 第一次带配置字段调用时保持 \`apply=false\`，把精确变更展示给用户。
- 只有用户确认后，才使用同一组字段和 \`apply=true\`。
- 不向用户索要 API Key 明文。字幕和封面凭据只能让用户在内容工作台的设置页通过 Harness Credentials 配置。
- 高级依赖路径由插件配置或环境自动发现；能自动发现时不要增加问题。

## 内容目录

- 磁盘文件是正文真源；工作台 overlay 只保存绑定、阶段和发布状态。
- 一集一个子目录，默认命名为 \`YYYY-MM-DD_可读标题\`。
- 先列目录，再读这一集需要的 \`topic.md\`、\`script.md\`、发布包、字幕或文章文件。
- 首次保存文件前先在工作台调用系统目录选择器。已确认资料位置后，创建新内容使用 \`oil_create_content\`；修改普通 Markdown 和 JSON 正文使用系统文件工具。

## 整理与发布安全

- 调用 \`oil_organize_library\` 时先预览，向用户列出改名前后；确认后才传 \`apply=true\`。它不删除文件。
- 发布默认准备草稿。上传、账号登录和最终发表属于外部发布能力；最终发表必须由用户明确确认。
- 自动发布（\`video-publisher\` skill）和已发布数据回收（\`oil_sync_publish\`）只处理 \`enabledPlatforms\` 中的平台，都依赖 Ego Browser 和已登录的创作者后台；\`enabledPlatforms\` 为空时不执行发布或同步，先配置并确认启用平台。能力检查显示缺失时明确告诉用户这两项不可用，其余功能照常。

## 推进工作

每次只推进当前缺失的下一步：选题与脚本 → 录制/工程 → 导出成片 → 字幕 → 封面 → 视觉审查 → 发布草稿 → 用户最终发表 → 同步数据。

- \`oil_wait_export\`、\`oil_generate_subtitles\`、\`oil_burn_subtitles\`、\`oil_generate_cover\` 返回 Harness job id。用 \`job_output\` 的 \`wait=true\` 等待并查看完成结果，用 \`job_kill\` 取消，不轮询文件夹冒充任务控制器。
- 封面任务完成后调用 \`oil_prepare_visual_review\`，检查三画幅构图、文字可读性、安全区、适配和品牌一致性；再用 \`oil_save_visual_review\` 保存具体结论。不把“已经启动”说成“已经完成”。`,
};

export function registerCreatorWorkbenchSkill(ctx: SkillsContext): () => void {
  return ctx.skills.register(CREATOR_WORKBENCH_SKILL);
}
