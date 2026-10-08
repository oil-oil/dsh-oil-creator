# 内容工作台：现阶段实现

`dsh-oil-creator` 0.2.0 面向 DSH Desktop 0.11.0 内置 Harness 0.2.0-rc.2。内容列表和详情作为业务面板注册到 `desktopWorkbenches`；Desktop 持有公共导航与原生会话。实际验收边界见 [迁移记录](desktop-compliance.md)。

`dsh.bundle.patch` 只插入自身 Cordis 行。`dsh.client.inject` 包含 `dsh-desktop-workbenches`，注册使用规范 GitHub repository，不填写旧 workbench id。注册、样式、Remote 和列表同步均随 fiber 卸载清理。

## 最终要做成什么样

目标是一条能走完的创作流水线，人在关键处动手，机器包办重复劳动。日常路径是：

1. **选题**：在对话里讨论这一期讲什么，插件建一个当天的内容文件夹，笔记写进 `topic.md`。
2. **录制**：用 Screen Studio 录。插件可以绑定 `.screenstudio` 工程。
3. **剪辑**：对话里走 `screen-studio-editor` 清理停顿和误讲。人打开工程预览，确认后再亲手导出 MP4。插件不代替导出。
4. **等导出**：导出开始后，插件盯着影片目录，成片稳定落盘再往下走。这段时间可以并行做字幕和封面。
5. **字幕**：用百炼 Key 转录；`oil-subtitle` 首次 clone 后必须运行 `bash ~/.agents/skills/oil-subtitle/setup.sh`；人在 skill 自带的预览编辑器里改稿，确认后再烧进视频。
6. **封面**：有 ZenMux Key 就出 3:4 / 4:3 / 16:9。封面主标题和错别字由对话里的 Agent 核对，不交给脚本自行发挥。
7. **标签与发布包**：`publish-package.json` 给四个视频平台，只需要标题和 tags，不写平台长文案。`enabledPlatforms` 默认启用小红书、抖音、B 站、视频号四个平台，关闭的平台不参与 AI 发布和数据同步。公众号文章是旁边的 Markdown，不是第五个视频平台，走 `oil-video-article`，成稿在 `公众号文章/`。
8. **发布**：`video-publisher` 只为 `enabledPlatforms` 中的平台准备草稿，做到最终发布按钮前，人自己点发布。插件记录每平台未发布 / 草稿已备 / 已发布。
9. **回收**：用 Ego Lite 打开已登录的创作者后台，只翻 `enabledPlatforms` 中平台的已发布列表，按标题或已存 id 对到本地文件夹，写下播放 / 赞 / 评论。不是公开站爬虫；平台上有、本地没有文件夹的不会自动建条目。

一条片子对应影片目录里的一个子文件夹。工程在 Screen Studio 工程目录里，用绑定连起来。

## 现阶段已经能做什么

| 环节 | 现状 |
| --- | --- |
| 列表与检查器 | 工作台内显示内容列表与详情；窄面板在列表和详情间切换，关闭详情回到列表 |
| 建内容、选题笔记 | 面板新建；`oil_create_content` 建文件夹；选题写 `topic.md` |
| 绑定 / 打开工程 | 面板换绑、打开；`oil_open_studio` |
| 等导出 | `oil_wait_export` 返回 Harness job id；成片稳定后任务完成并清掉 waiting 标记 |
| 字幕预览、烧录、生成 | 对话工具通过 Harness Jobs 提供等待、取消和完成通知；界面按钮仍显示 overlay 产物状态 |
| 生成与审查封面 | 后台任务生成三画幅；`oil_prepare_visual_review` 注入图片附件，`oil_save_visual_review` 保存审查产物 |
| 发布状态 | 读 `{标题}.auto-publish.json`；点状态胶囊从菜单里选未发布 / 草稿 / 已发布，手写优先 |
| 已发布数据 | 检查器「同步已发布」只对当前这一期：找到标题就停翻页，overlay 也只写这一条。`oil_sync_publish` 不传 id 才同步整库 |
| API Key | 内容工作台顶部 → 设置；和视觉识别共用官方凭据 |
| 公众号 | 只显示目录里有没有 `公众号文章/`，不生成 |
| 剪辑、多平台上传 | 还没从插件里调度，对话里继续用原来的 skill |

上面这张表是工作台已经具备的能力：能看列表、绑定工程、启动字幕和封面脚本、标记发布状态。对照「最终要做成什么样」那 9 步，整条创作路径还没有全部接到插件里。现在有的是一条片子的工作台和几个可点的执行入口，不是点一次就从选题走到待发布。

日常路径里，插件还包不住、仍要在对话里自己喊 skill 或亲手做的：

1. **剪辑**：只能打开工程，不会替你跑 `screen-studio-editor`。
2. **导出后的并行编排**：「导出开始就同时做字幕和封面」没有连成一条自动流水。
3. **字幕校对**：生成完不会自动改专有名词；预览还要人自己看。
4. **界面内自动视觉审查**：多模态审查已接到对话工具，界面按钮本身仍不会自动触发 Agent 判断。
5. **发布包**：能展示已有 `publish-package.json` 里的标签，不会在插件里写平台长文案。
6. **四平台上传**：不会调度 `video-publisher`，只记状态。
7. **公众号成稿**：不会跑 `oil-video-article`。
8. **没有本地文件夹的旧作**：同步会翻完创作者后台的已发布列表，但对不上本地片子的不会自动建文件夹。

工作阶段（`workflow`）由文件和 overlay 推出来，不是单独手填一张总表：

- `idle` 未开始
- `record` 待录制（overlay 里标了准备录）
- `cut` 待剪辑（已绑工程、还没有成片）
- `finish` 待加字幕 / 封面
- `publish` 待发布（字幕和封面都齐）

## 一层工作台，skill 继续执行重活

保持 **一个** Harness 插件。官方要求：只有能力需要独立替换时才拆包，不要预防性拆分。见 DeepSeek Harness `docs/user/develop/practice/index.zh.md`。

业务设置位于工作台内，仍通过同一个 Remote 保存到 overlay。Host Settings 使用当前 `configure({ auto: false })`，不注册旧设置卡槽。凭据调用当前 `remote.credentials.describe(refs)` / `set(ref, value)`，页面只取得脱敏状态。

执行分工：

- **磁盘文件**：片子的正文。约定见 [files.md](files.md)。模型用系统自带的列文件 / 读文件 / 写文件。
- **插件**：工作台片库、详情、阶段推导、官方凭据、仅向仍可用的本工作台所属会话提供文件约定（`system-prompt/assemble` 中的 `oil:library`）。核心界面和 `oil_*` 工具不依赖专用 Agent Preset。
- **内置 Skill**：`creator-workbench` 负责首次体检、配置预览、目录整理和发布安全流程。普通带 Skill 与文件工具的 Agent 就能使用，推荐 `standard` 或 `code`；`minimal` 不适合这条引导。专用 Creator Preset 以后只作为可选入口。
- **Harness 工具**：用官方 `defineTool` 注册。只做文件做不到的事，或启动一项已经约定好的脚本。长任务通过 `ctx.jobs` 返回 `oil-media-*` id，由官方 `@deepseek-ai/dsh-tool-jobs` 负责等待、读取、取消和完成通知；overlay 保留重启后的产物状态。Web 的 `standard` / `code` preset 已装配该控制器，`minimal` 不承载这条长任务链。
- **Skill 脚本**：ASR、FFmpeg 烧录、选帧生图。不要把 Python 和 SOP 整份搬进 `execute()`。
- **对话里的 Agent**：校对字幕、提炼封面主标题、看封面错别字、审查剪辑报告。这些判断留在对话里。

对话里的插件工具：

`oil_creator_guide`、`oil_script_rules`、`oil_creator_setup`、`oil_create_content`、`oil_update_content`、`oil_creator_profile`、`oil_organize_library`、`oil_sync_publish`、`oil_open_studio`、`oil_wait_export`、`oil_open_subtitle_preview`、`oil_burn_subtitles`、`oil_generate_subtitles`、`oil_generate_cover`、`oil_prepare_visual_review`、`oil_save_visual_review`

`oil_creator_guide` 是自举入口：用户不知道插件能做什么、或模型不确定下一步时调用，返回带当前能力状态的完整指引，包括 Ego Browser 缺失时自动发布和数据回收不可用。`oil_script_rules` 读写脚本规则（人设），存在 overlay 里；写或改 `script.md` 前模型先读它。`oil_creator_setup` 无参数时只读检查目录、操作系统、Screen Studio、字幕、封面、凭据和 Ego Browser。带配置字段但 `apply=false` 时只返回提案；只有用户确认后才用 `apply=true` 写入。可选依赖缺失只降级对应能力，不影响片库核心。

业务根容器按正常 flex 布局填满宿主分配区域，顶部语义 header 使用 `--dsh-frame-leading-clearance` 避让窗口控制。业务布局不定位或修改宿主的聊天 DOM。原生对话保留在 Desktop 标准 Frame 内。

新建内容先弹出宿主目录选择器，取消不改配置、不创建文件。已选内容的会话动作通过 `ensureSession` 创建或恢复，只有 Desktop 已确认归属本工作台的 saved session 才传入恢复参数。会话的内容和目录映射保存在本地 UI 状态。异步动作在工作台切换后不更新前台选择，不自动填入或发送消息。

文件打开走插件 Remote，Host 用 realpath 核对目标在当前资料目录内，再调用系统打开命令，不要求先建会话。列表排序、封面、视频、脚本、字幕、文章和发布状态继续使用原有业务实现。

## 状态存在哪里

不要往 `overlay.json` 里写 API Key，也不要把密钥回读到页面。

| 数据 | 位置 |
| --- | --- |
| 影片目录、`enabledPlatforms`、脚本规则（人设）、工程绑定、待录制、等导出、手写发布状态、同步到的播放/赞/评、烧录/生成任务 | `~/.dsh-oil-creator/overlay.json` |
| 成片、字幕、封面、发布包、公众号文章 | `~/Movies/视频项目/<日期_标题>/` |
| 字幕和封面 Key | Harness 官方凭据（字幕用 `DASHSCOPE_API_KEY`、封面用 `ZENMUX_API_KEY`） |
| 视觉审查 | 每期目录的 `visual-review.json` / `visual-review.md`；图片通过 Harness 附件服务临时进入模型上下文 |
| 列表选中项、每个所属会话的内容与目录映射 | 浏览器本地 UI 状态（沿用 v1 key，保留旧数据） |

发布状态两层：文件夹里的 `{标题}.auto-publish.json` 推断草稿；overlay 里的手写状态盖过它。Ego 同步成功后，对应平台写成 `published`，并带上 `url` / `views` / `likes` / `comments` / `syncedAt`，来源记为 `sync`。

采集本身是机械脚本，不经过模型判断：

```text
ego-browser nodejs < scripts/collect-publish.mjs
```

采集脚本每次开一个新的 `oil-collect-*` 空间，跑完就关掉，并清掉登记表里已死进程留下的旧空间，以及历史遗留名 `oil-collect-publish`。它不会按前缀扫掉其他还在跑的 `oil-collect-*`。`pnpm build` 用原地覆写把 `scripts/collect-publish.mjs` 写进 `lib/`，避免 `cp` 断开 profile 里 `file:` 依赖的硬链接。翻页范围：小红书 `note/user/posted`（列表滚到底）、抖音 `work_list`（`max_cursor`）、B 站 `/x/web/archives`（`pn`）、视频号 `post/post_list`（`currentPage`）。对上之后把 `remoteId` 写进 overlay，下一次优先按这个 id 对齐，不再只靠标题。

90 秒内再点同步会直接用 `~/.dsh-oil-creator/collect-cache.json`。超过这个时间再跑 Ego。可用 `OIL_COLLECT_KEEP=1` 留下页面，`OIL_COLLECT_SPACE` 指定空间名，`OIL_COLLECT_PLATFORMS=wechat,douyin` 只跑其中几个。工作台按钮和 `oil_sync_publish` 走同一条脚本。

文件夹约定：`YYYY-MM-DD_可读标题`。发布包规范名是 `publish-package.json`。带字幕的成片文件名含 `_subtitled`。

## 实现时参考什么

先官方约定，再打开对应 skill。不要重新发明目录、密钥或烧录参数。

### DeepSeek Harness（仓库 `~/Desktop/project/deepseek-harness`）

当前协议、版本核对、验证证据与未实测项统一记录在 [desktop-compliance.md](desktop-compliance.md)。旧侧栏、overlay 与设置槽适配器已退出 0.2.0 源码，不再外推旧版 Desktop 的兼容结论。
