<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-oil-creator：让 AI 和本地内容目录一起工作">
</p>

<p align="center">
  <strong>DeepSeek Harness 上的本地内容工作台。</strong><br>
  从选题、脚本、录屏工程到字幕、封面和发布状态，一条片子始终对应一个本地文件夹。
</p>

> [!NOTE]
> 当前开发目标为 Node.js 22.19+、DSH Desktop `0.11.0` 内置的 Harness `0.2.0-rc.2`；需要 Desktop 的 `desktopWorkbenches` 服务，不适用于独立 Harness Web。核心片库可独立使用；Screen Studio、字幕、封面、公众号和发布能力均可按需安装。

## 一条片子，就是一个文件夹

插件不建立封闭的内容数据库。正文和产物仍是普通文件，任何编辑器和 AI 文件工具都能读取：

```text
~/Movies/视频项目/
└── 2026-08-19_DeepSeek Harness 上手/
    ├── topic.md
    ├── script.md
    ├── DeepSeek Harness 上手.mp4
    ├── DeepSeek Harness 上手.srt
    ├── DeepSeek Harness 上手_subtitled.mp4
    ├── DeepSeek Harness 上手_3x4.png
    ├── DeepSeek Harness 上手_4x3.png
    ├── DeepSeek Harness 上手_16x9.png
    ├── visual-review.json
    ├── visual-review.md
    ├── publish-package.json
    └── 公众号文章/
```

插件只把工程绑定、手写发布标记、同步到的播放数据和生成任务等工作台状态存进 `~/.dsh-oil-creator/overlay.json`，不会把正文复制一份藏起来。

## 一条片子如何向前推进

| 阶段 | AI 与插件可以做什么 | 仍由人确认什么 |
| --- | --- | --- |
| 选题与脚本 | 新建规范目录，读写 `topic.md` / `script.md`，遵守长期脚本规则 | 选题方向和最终表达 |
| 录制与剪辑 | 绑定并打开 Screen Studio 工程，等待导出文件稳定落盘 | 录制、时间线剪辑和导出 |
| 字幕与封面 | 用 Harness Jobs 跟踪、等待和取消长任务；生成三画幅封面后交给多模态模型审查并保存报告 | 专有名词和最终视觉取舍 |
| 发布 | 把本地材料交给 `video-publisher` 准备多平台草稿 | 各平台最终“发表”按钮 |
| 数据回收 | 通过 Ego Browser 同步已发布作品的播放、赞、评和链接 | 登录状态和异常匹配结果 |

工作台不会假装替人完成录制、剪辑或最终发布。它负责把每一步需要的文件、状态和下一步动作放在同一个上下文里。

## 开始使用

### 1. 安装插件

先从本地源码构建可安装包：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm pack
```

在当前 Desktop 的「工作台管理／已安装的工作台」核对本地 `.tgz` 安装入口，或用该 Desktop 配套的 `dsh plugin add --help` 核对支持的输入与参数。只使用明确支持本地包的入口安装生成的 `dsh-oil-creator-0.2.0.tgz`；重启 Harness 后从工作台管理添加并打开「内容工作台」。不要使用另一个版本的全局 CLI 推断 Desktop 支持情况。

已完成类型检查、构建和 251 项测试，预构建包已安装到 macOS arm64 的 Desktop 0.11.0 并打开内容工作台。市场投稿的最终安装来源与逐项验证记录见 [迁移验收记录](docs/desktop-compliance.md)。独立 Harness Web 和其他平台未验证。

### 2. 让 AI 完成首次配置

推荐选择 Harness 的 `standard` 或 `code` Agent preset，然后直接说：

> 检查并配置内容工作台，找到适合的内容目录，并告诉我还缺哪些能力。

内置 `creator-workbench` Skill 会先调用只读的 `oil_creator_setup`：

1. 寻找已有的内容目录。
2. 检查 Screen Studio、字幕、封面和 Ego Browser 等可选能力。
3. 只报告凭据是否已配置，不把 API Key 读回对话。
4. 先预览配置变化，得到确认后才保存。

首次保存文件前，在工作台的系统目录选择器中选择资料目录；需要新建目录时也在系统选择器中明确操作。取消选择会保留标题和原业务选择。`minimal` preset 不包含 Skill 和文件工具，不适合首次配置或自动整理目录。

### 3. 做第一条内容

从工作台新建内容会先选择资料位置，不要求已有会话。选中一期后点击「打开内容会话」，在选择器中确认这一期的目录，由 Desktop 创建或恢复属于内容工作台的原生会话；不会自动发送消息。

可以直接对 AI 说：

> 今天做一期 DeepSeek Harness 安装上手。新建内容目录，把选题写进笔记，再给我一个脚本初稿。

随后继续说“绑定刚才的 Screen Studio 工程”“等待成片后生成字幕和封面”或“这条还缺什么”。工作台会根据文件夹里的真实产物推进阶段。

## 核心能力

- **本地片库**：按 `日期_可读标题` 扫描目录，展示阶段、成片、字幕、封面、文章和发布状态。
- **对话上下文**：在属于本工作台的会话里，通过 `@当前详情`、内容搜索或 `/current content` 把目标文件夹交给 AI。
- **AI 自举配置**：自动发现标准安装路径，缺少能力时给出明确安装方式，写入前必须预览和确认。
- **长期脚本规则**：保存语气、结构、禁忌和目标观众，之后写或修改 `script.md` 时复用。
- **原生长任务**：字幕、封面、烧录和导出等待都返回 Harness job id，可统一查看、等待、取消并接收完成通知。
- **多模态封面审查**：把三画幅封面作为 Harness 附件交给模型检查，并把结构化结论保存为 `visual-review.json` / `.md`。
- **目录整理**：预览并修正旧文件夹名称；默认不执行、不删除文件。
- **可选发布闭环**：准备平台草稿后由人最终发表，再同步播放、点赞、评论和作品链接。

完整工具列表和逐步示例见 [使用说明](docs/usage.md)。

## 可选能力

核心片库和脚本管理不依赖下表中的外部工具。缺少某项时，只关闭对应环节。

| 能力 | 可选依赖 | 说明 |
| --- | --- | --- |
| 字幕转录、排版、预览和烧录 | [oil-subtitle](https://github.com/oil-oil/oil-subtitle) + `DASHSCOPE_API_KEY` | 首次 clone 后必须运行 `bash ~/.agents/skills/oil-subtitle/setup.sh`；Key 在[百炼控制台](https://bailian.console.aliyun.com)申请 |
| 三画幅封面 | [oil-cover](https://github.com/oil-oil/oil-cover) + `ZENMUX_API_KEY` | Key 在 [ZenMux](https://zenmux.ai) 申请 |
| Screen Studio 自动剪辑 | [screen-studio-editor](https://github.com/oil-oil/screen-studio-editor) | 仅 macOS；录制和导出仍在 Screen Studio 完成 |
| 多平台草稿与数据回收 | [Ego Lite](https://lite.ego.app/) + [video-publisher](https://github.com/oil-oil/video-publisher-skill) | 仅 macOS；需要提前登录各平台创作者后台 |
| 公众号图文 | [oil-video-article](https://github.com/oil-oil/oil-video-article) | 独立工作流，工作台负责展示已有文章 |

字幕和封面 Skill 留空时，插件会依次从 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 自动发现；只有非标准安装位置才需要填写高级路径。

## 配置原则

设置入口位于 **内容工作台顶部 → 设置**。设置页只保留需要人决定的信息，例如内容目录、脚本规则和可选能力凭据；可以通过系统检查发现的路径不重复暴露。

- API Key 使用 Harness 官方凭据服务保存。页面只显示“已配置 / 未配置”，不会回显明文。
- 内容目录可以换成任意已有的绝对路径，每个直接子文件夹代表一条内容。
- `enabledPlatforms` 默认全开，包含小红书、抖音、B 站和视频号。关闭的平台不会参与 AI 发布或数据同步；全部关闭时不执行这两项操作。
- 脚本规则既可以在设置页修改，也可以让 AI 通过 `oil_script_rules` 记录和更新。
- Cordis 高级配置仍保留 `libraryRoot`、`dataDir`、`subtitleSkillDir` 和 `coverSkillDir`，用于自动发现无法覆盖的特殊环境。

## 数据与权限边界

- 正文、视频、字幕、封面和文章保存在用户选择的本地目录。
- 插件不会自动上传内容；上传只在用户明确调用发布 Skill 后发生，并停在最终发表前。
- 字幕、封面和平台同步会访问各自的外部服务；不安装、不配置就不会启用。
- 目录创建、配置保存和批量重命名都遵循“先预览、再确认、后执行”。

## 卸载与旧版迁移

通过当前 Desktop 的插件管理入口卸载，再重启 Harness。内容目录、overlay 状态和已有会话不随插件删除。

新版 bundle patch 只插入本包；公共侧栏、工作台切换和原生聊天由 Desktop 管理。旧版如果在用户 profile 中额外手写过 `ui-sidebar: disabled`，升级时应检查并移除那项历史覆盖；不要把本项目的 patch 复制到用户配置。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 会依次运行 TypeScript 检查、Host / Client 构建和 Vitest 测试。欢迎提交 Issue 或 Pull Request；涉及文件格式、配置兼容或外部能力时，请同时补充对应测试和文档。

准备推送开源提交或创建 GitHub tag 前运行 `pnpm release:check`。它会先拒绝脏工作树、未跟踪的关键文件或缺失的 `origin`，再验证测试、构建和 GitHub 安装包内容；不会发布到 npm。

## 文档

- [日常使用与完整工具说明](docs/usage.md)
- [内容文件夹约定](docs/files.md)
- [插件实现与兼容性说明](docs/implementation.md)

## 使用问题

安装或使用过程中遇到问题，可以到 [oiloil.org](https://www.oiloil.org/#consulting) 联系我。代码缺陷和功能建议仍然欢迎提交 Issue。

## License

[MIT](LICENSE)
