# Desktop 工作台迁移验收记录

记录日期：2026-10-08。包版本：`dsh-oil-creator@0.2.0`。

本次将既有内容创作插件迁移到 Desktop 工作台结构，保留片库、脚本、录屏工程、字幕、封面、文章、发布状态和相关工具。修改基于本地现有工作树，保留迁移前尚未提交的业务改动。

## 规范与版本证据

- 开发规范：[DSH Desktop 工作台开发规范](https://dshdesktop.com/workbench/docs/development.md)，读取版本日期为 2026-09-29。
- 目标宿主：本机 `/Applications/DSH Desktop.app`，Desktop `0.11.0`，macOS arm64，当前 profile 为 `web`。
- 目标内置 Harness：`0.2.0-rc.2`；Cordis：`4.0.4`。契约核对使用安装应用中的实际包清单、工作台 Host/Client 和输入触发器实现，以及对应 npm 包类型。
- 另一个本地 Harness 源码目录为旧版本 `0.1.0-rc.5`，不作为本次 Desktop API 的判断依据。

## 已完成的迁移

| 范围 | 实现 |
| --- | --- |
| 安装装配 | patch 只插入本包自己的 Cordis 行；移除旧版公共侧栏替换与业务 overlay 注册 |
| 工作台入口 | 通过上下文 `desktopWorkbenches.register` 注册「内容工作台」，由 Host 分配归属，释放时注销 |
| Client 交付 | 单文件 ModuleLoader 入口；显式声明工作台信息依赖；React 和 primitives 使用宿主模块 |
| 布局 | Host 边界内的业务标题、片库、详情和设置；标题预留系统 frame clearance；窄业务区支持列表／详情切换 |
| 会话 | 浏览与新建无需会话；通过 `ensureSession` 使用原生会话；不自动发送消息，不传入原生或其他工作台的会话 id |
| 目录确认 | 新建内容与首次内容会话使用系统目录选择器；取消不创建文件或会话；创建请求固定到选中的目录 |
| 恢复 | 自有会话绑定完整内容路径；同名内容跨片库恢复时校验目录；目录搬迁后保留旧会话历史，新会话使用新工作区 |
| 异步状态 | 目录选择、列表刷新、详情加载和会话恢复检查导航是否仍有效；旧响应不会覆盖后续选择 |
| 编辑 | 脚本草稿按完整目录保留；Host 保存时校验目标目录，拒绝写入切换后的同名内容 |
| 数据范围 | 私有片库提示与输入触发器限于本工作台所属会话；打开路径校验真实目录与符号链接边界 |
| API 适配 | 更新 Credentials 参数、Jobs 结果及会话归属字段、Typert schema 工厂；设置位于业务工作台内 |

## 验证证据

| 检查 | 结果与范围 |
| --- | --- |
| 锁文件安装 | `pnpm install --frozen-lockfile --ignore-scripts` 通过，DSH 相关依赖与目标版本对齐 |
| 完整检查 | `pnpm check` 通过：类型检查、Host/Client 构建、41 个测试文件／249 项测试 |
| 最终导航修正 | 补充类型检查、构建以及 workbench、clientApply、contentScope 三组针对性测试 |
| 文件行为 | 临时真实目录验证：同 id 跨片库脚本保存拒绝错写；目录边界与越界符号链接拒绝打开 |
| Client 产物 | 测试执行真实构建的 `lib/client.js`，通过 VM 和严格基线模块 mock 检查注册、卸载、取消及创建；这不是 Desktop 官方 Loader 或真实 UI 验收 |
| Host 导入 | 构建后的 `lib/index.js` 可在 Node 中导入，导出 Config、apply 和 name |
| 打包 | 交付 `.artifacts/dsh-oil-creator-0.2.0.tgz`；验包及 SHA-256 记录在本地 `.artifacts/pack-report.json` |
| Skill 检查器 | `check_plugin.mjs --harness-version 0.2.0-rc.2` 拒绝未知模块表，未算作通过；未用旧版本参数绕过 |
| 发布门禁 | 未对用户的脏工作树运行发布流程、提交或推送；release:check 本身的回归测试通过 |

## 尚未完成的宿主验收

本次未修改真实 Desktop profile，也未完成安装、重启、最终配置 dump、boot manifest、Client load report 与官方 Loader 的运行验证。

当前 Desktop 配套 CLI 在只读执行 `plugin add --help` 时失败，缺少入口：

```text
/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/desktop-cli.js
```

不能用另一版本的全局 CLI 代替当前 Desktop 安装能力。需要在当前 Desktop 的真实安装入口确认本地包支持情况，再安装这个已打包产物。

真实窗口的空态、加载态、错误态、选中态、浅色／深色、窄窗口、设置切换、目录取消、所属会话恢复和卸载清理均待验收。此次没有授权浏览器自动化，因此代码检查不能替代视觉与真实宿主结果，也不能宣称已完成全部规范验收。

## 本地交付与保留

- 源码和锁文件位于原仓库；未提交、推送或发布。
- 迁移前已有改动的补丁保存在 `.artifacts/before-compliance.patch`。
- 移除的旧版侧栏／overlay 源码副本保存在 `.artifacts/legacy-source/`。
- `.artifacts/` 由 Git 忽略，备份不进入 npm 安装包。

## 市场准备复核（2026-10-08）

随后通过 Desktop 随附 Harness CLI 的实际入口完成安装，绕过失效的旧 CLI 包装器；未使用其他版本的全局 CLI。运行 web profile 中的 0.2.0 Host、client、Typert 与采集脚本均逐字节匹配最新构建。Desktop 工作台切换器中已有「内容工作台」，业务面板实际打开且搜索输入可用。`pnpm check` 再次完成，41 个文件、251 项测试通过；前述未验证项仍须以最终市场验收表补充，不能把早期记录当成全量通过。
