import { closeSync, constants, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { access, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createServer as createServer$1 } from "node:http";
//#region src/config.ts
function defaultLibraryRoot(platform = process.platform) {
	const videos = platform === "darwin" ? "Movies" : "Videos";
	return join(homedir(), videos, "视频项目");
}
function defaultDataDir() {
	return join(homedir(), ".dsh-oil-creator");
}
function defaultSubtitleSkillDir() {
	return join(homedir(), ".claude", "skills", "oil-subtitle");
}
function defaultCoverSkillDir() {
	return join(homedir(), ".claude", "skills", "oil-cover");
}
function skillDirCandidates(skillName, home = homedir()) {
	return [
		join(home, ".claude", "skills", skillName),
		join(home, ".codex", "skills", skillName),
		join(home, ".agents", "skills", skillName),
		join(home, ".grok", "skills", skillName)
	];
}
function joinUnderHome(home, rest) {
	return join(home, ...rest.replaceAll("\\", "/").split("/").filter(Boolean));
}
function expandHomePath(path, home = homedir()) {
	const trimmed = path.trim();
	if (trimmed === "~" || trimmed === "%USERPROFILE%" || trimmed === "%HOME%") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return joinUnderHome(home, trimmed.slice(2));
	const windowsHome = /^%(?:USERPROFILE|HOME)%([\\/].*)?$/i.exec(trimmed);
	if (windowsHome !== null) {
		const rest = windowsHome[1];
		return rest === void 0 || rest === "" ? home : joinUnderHome(home, rest);
	}
	return trimmed;
}
defaultLibraryRoot();
const Config = Schema.object({
	libraryRoot: Schema.string().default(defaultLibraryRoot()),
	dataDir: Schema.string().default(defaultDataDir()),
	subtitleSkillDir: Schema.string().default(""),
	coverSkillDir: Schema.string().default("")
});
function resolveDataDir(config) {
	return config.dataDir === "" ? defaultDataDir() : config.dataDir;
}
function resolveSkillDir(configured, skillName, envValue) {
	if (configured.trim() !== "") return expandHomePath(configured);
	if (envValue !== void 0 && envValue.trim() !== "") return expandHomePath(envValue);
	return skillDirCandidates(skillName).find((candidate) => existsSync(candidate)) ?? skillDirCandidates(skillName)[0];
}
//#endregion
//#region src/backgroundJobs.ts
const BACKGROUND_OUTPUT = {
	type: "object",
	additionalProperties: false,
	properties: {
		kind: {
			type: "string",
			required: true,
			const: "background"
		},
		jobId: {
			type: "string",
			required: true
		}
	}
};
function message(cause) {
	return cause instanceof Error ? cause.message : String(cause);
}
function present$1(title, rawInput) {
	return {
		card: "generic",
		title,
		kind: "execute",
		rawInput
	};
}
function backgroundOutput() {
	return {
		schema: BACKGROUND_OUTPUT,
		render: (_args, value) => [{
			type: "text",
			text: `started background job ${value.jobId}`
		}]
	};
}
async function assertMediaIdle(service, id, fields, signal) {
	const detail = await service.getContent({ id }, signal);
	const running = fields.find((field) => detail[field].status === "running");
	if (running !== void 0) throw new Error(`${id}: ${running} is already running`);
}
async function assertExportIdle(service, id, signal) {
	if ((await service.getContent({ id }, signal)).waitingForExport) throw new Error(`${id}: export wait is already running`);
}
function startExclusiveJob(jobs, active, key, spec, run) {
	if (active.has(key)) throw new Error(`${key}: background job is already running`);
	try {
		return jobs.start({
			...spec,
			run: () => {
				if (active.has(key)) throw new Error(`${key}: background job is already running`);
				const hooks = run();
				active.add(key);
				hooks.done.then(() => {
					active.delete(key);
				}, () => {
					active.delete(key);
				});
				return hooks;
			}
		});
	} catch (cause) {
		if (message(cause).includes("no job controller")) throw new Error("background jobs unavailable: use the Harness standard or code preset with @deepseek-ai/dsh-tool-jobs");
		throw cause;
	}
}
function mediaHooks(service, id, field, start) {
	const controller = new AbortController();
	return {
		cancel: (reason) => {
			if (!controller.signal.aborted) controller.abort(new Error(reason ?? "cancelled"));
		},
		done: (async () => {
			try {
				await start(controller.signal);
				const job = await service.waitForMediaJob(id, field, controller.signal);
				if (job.status === "done") return {
					status: "completed",
					detail: field,
					result: job.output ?? `${id}: completed`
				};
				return {
					status: "failed",
					detail: field,
					result: job.error ?? `${id}: failed`
				};
			} catch (cause) {
				if (controller.signal.aborted) {
					try {
						await service.cancelMediaJob(id, field);
					} catch (cleanupCause) {
						return {
							status: "failed",
							detail: "cancel cleanup failed",
							result: message(cleanupCause)
						};
					}
					return {
						status: "killed",
						detail: field,
						result: `${id}: cancelled`
					};
				}
				return {
					status: "failed",
					detail: field,
					result: message(cause)
				};
			}
		})()
	};
}
function exportHooks(service, id, timeoutMs) {
	const controller = new AbortController();
	return {
		cancel: (reason) => {
			if (!controller.signal.aborted) controller.abort(new Error(reason ?? "cancelled"));
		},
		done: (async () => {
			try {
				await service.waitForExport(timeoutMs === void 0 ? { id } : {
					id,
					timeoutMs
				}, controller.signal);
				const detail = await service.waitForExportCompletion(id, controller.signal);
				if (detail.exportTimedOut === true) return {
					status: "failed",
					detail: "export timed out",
					result: `${id}: export timed out`
				};
				return {
					status: "completed",
					detail: "export ready",
					result: detail.videoSubtitled ?? detail.videoRaw ?? `${id}: export ready`
				};
			} catch (cause) {
				if (controller.signal.aborted) {
					try {
						await service.cancelExportWait(id);
					} catch (cleanupCause) {
						return {
							status: "failed",
							detail: "cancel cleanup failed",
							result: message(cleanupCause)
						};
					}
					return {
						status: "killed",
						detail: "export wait",
						result: `${id}: cancelled`
					};
				}
				return {
					status: "failed",
					detail: "export wait",
					result: message(cause)
				};
			}
		})()
	};
}
function registerCreatorJobTools(ctx, service) {
	const active = /* @__PURE__ */ new Set();
	ctx.tools.register(defineTool({
		name: "oil_wait_export",
		description: "Watch an episode folder for a stable MP4/MOV export as a Harness background job. Returns a job id immediately; use job_output with wait=true for completion and job_kill for cancellation.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Folder id."
			},
			timeoutMs: {
				type: "integer",
				description: "Timeout in milliseconds. Default 2 hours."
			}
		},
		output: backgroundOutput(),
		presentCall: (args) => present$1("Wait for export", args),
		execute: async (args, exec) => {
			if (args.id.trim() === "") throw new Error("id is required");
			exec.signal.throwIfAborted();
			await assertExportIdle(service, args.id, exec.signal);
			return {
				kind: "background",
				jobId: startExclusiveJob(ctx.jobs, active, `${args.id}:export`, {
					kind: "oil-media",
					label: `Wait for export: ${args.id}`,
					...exec.agent === void 0 ? {} : { owner: exec.agent.session.id }
				}, () => exportHooks(service, args.id, args.timeoutMs))
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_burn_subtitles",
		description: "Burn the confirmed subtitle draft as a Harness background job. Open and confirm the subtitle preview first; use job_output with wait=true or job_kill for control.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Folder id."
		} },
		output: backgroundOutput(),
		presentCall: (args) => present$1("Burn subtitles", args),
		execute: async (args, exec) => {
			if (args.id.trim() === "") throw new Error("id is required");
			exec.signal.throwIfAborted();
			await assertMediaIdle(service, args.id, ["burn"], exec.signal);
			return {
				kind: "background",
				jobId: startExclusiveJob(ctx.jobs, active, `${args.id}:burn`, {
					kind: "oil-media",
					label: `Burn subtitles: ${args.id}`,
					...exec.agent === void 0 ? {} : { owner: exec.agent.session.id }
				}, () => mediaHooks(service, args.id, "burn", (signal) => service.startSubtitleBurn({ id: args.id }, signal)))
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_generate_subtitles",
		description: "Transcribe, review, and lay out subtitle drafts as a Harness background job. Completion opens the preview editor; use job_output with wait=true or job_kill for control.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Folder id."
		} },
		output: backgroundOutput(),
		presentCall: (args) => present$1("Generate subtitles", args),
		execute: async (args, exec) => {
			if (args.id.trim() === "") throw new Error("id is required");
			exec.signal.throwIfAborted();
			await assertMediaIdle(service, args.id, ["subtitleJob", "burn"], exec.signal);
			return {
				kind: "background",
				jobId: startExclusiveJob(ctx.jobs, active, `${args.id}:subtitleJob`, {
					kind: "oil-media",
					label: `Generate subtitles: ${args.id}`,
					...exec.agent === void 0 ? {} : { owner: exec.agent.session.id }
				}, () => mediaHooks(service, args.id, "subtitleJob", (signal) => service.startSubtitleGenerate({ id: args.id }, signal)))
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_generate_cover",
		description: "Generate 3x4 / 4x3 / 16x9 covers as a Harness background job. Extract and pass the cover headline first; use job_output with wait=true or job_kill for control.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Folder id."
			},
			title: {
				type: "string",
				description: "Cover headline extracted from the episode."
			}
		},
		output: backgroundOutput(),
		presentCall: (args) => present$1("Generate cover", args),
		execute: async (args, exec) => {
			if (args.id.trim() === "") throw new Error("id is required");
			exec.signal.throwIfAborted();
			await assertMediaIdle(service, args.id, ["coverJob"], exec.signal);
			const request = {
				id: args.id,
				...typeof args.title === "string" && args.title.trim() !== "" ? { title: args.title } : {}
			};
			return {
				kind: "background",
				jobId: startExclusiveJob(ctx.jobs, active, `${args.id}:coverJob`, {
					kind: "oil-media",
					label: `Generate cover: ${args.id}`,
					...exec.agent === void 0 ? {} : { owner: exec.agent.session.id }
				}, () => mediaHooks(service, args.id, "coverJob", (signal) => service.startCoverGenerate(request, signal)))
			};
		}
	}));
}
//#endregion
//#region src/creatorSkill.ts
const CREATOR_WORKBENCH_SKILL = {
	name: "creator-workbench",
	description: "配置和使用内容工作台。首次使用、调整内容目录、整理目录、检查字幕/封面/发布能力，或推进一条内容时使用。",
	source: "runtime",
	invocation: {
		modelInvocable: true,
		userInvocable: true
	},
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
- 封面任务完成后调用 \`oil_prepare_visual_review\`，检查三画幅构图、文字可读性、安全区、适配和品牌一致性；再用 \`oil_save_visual_review\` 保存具体结论。不把“已经启动”说成“已经完成”。`
};
function registerCreatorWorkbenchSkill(ctx) {
	return ctx.skills.register(CREATOR_WORKBENCH_SKILL);
}
//#endregion
//#region src/platforms.ts
/**
* 共享发布平台契约。
*
* 保持本模块不依赖 Node 和 UI，让 Host、schema 与客户端复用同一份定义。
*/
const PUBLISH_PLATFORM_DEFINITIONS = {
	xiaohongshu: {
		name: "小红书",
		icon: "xhs",
		settingsLabel: "settings.platform.xiaohongshu",
		inspectorLabel: "inspector.platform.xhs",
		collectUrl: "https://creator.xiaohongshu.com/new/note-manager"
	},
	douyin: {
		name: "抖音",
		icon: "douyin",
		settingsLabel: "settings.platform.douyin",
		inspectorLabel: "inspector.platform.douyin",
		collectUrl: "https://creator.douyin.com/creator-micro/content/manage"
	},
	bilibili: {
		name: "B站",
		icon: "bilibili",
		settingsLabel: "settings.platform.bilibili",
		inspectorLabel: "inspector.platform.bilibili",
		collectUrl: "https://member.bilibili.com/platform/upload-manager/article"
	},
	wechat: {
		name: "视频号",
		icon: "wechat",
		settingsLabel: "settings.platform.wechat",
		inspectorLabel: "inspector.platform.wechat",
		collectUrl: "https://channels.weixin.qq.com/platform/post/list"
	}
};
const PUBLISH_PLATFORMS = Object.freeze(Object.keys(PUBLISH_PLATFORM_DEFINITIONS));
function isPublishPlatform$1(value) {
	return typeof value === "string" && value in PUBLISH_PLATFORM_DEFINITIONS;
}
function normalizeEnabledPlatforms(value) {
	if (!Array.isArray(value)) return [...PUBLISH_PLATFORMS];
	const enabled = new Set(value.filter(isPublishPlatform$1));
	return PUBLISH_PLATFORMS.filter((platform) => enabled.has(platform));
}
//#endregion
//#region src/libraryPrompt.ts
function resolvePromptLibraryRoot(source) {
	return source.cache?.libraryRoot ?? source.libraryRoot;
}
function enabledPlatformNames(platforms) {
	return platforms.map((key) => {
		if (Object.hasOwn(PUBLISH_PLATFORM_DEFINITIONS, key)) return PUBLISH_PLATFORM_DEFINITIONS[key].name;
		return key;
	}).join("、");
}
function libraryConventionText(libraryRoot, dataDir, scriptRules, enabledPlatforms) {
	const lines = [
		`创作者的视频内容以磁盘文件为准，目录是 ${libraryRoot}。首次使用或能力不明确时先调用 oil_creator_setup 做只读检查；用户问这个插件能做什么、怎么用，或你不确定下一步时，调用 oil_creator_guide 获取带当前能力状态的完整指引。`,
		"一集一个子文件夹，名字是 YYYY-MM-DD_可读标题。列出这个目录就是片库；打开一集先列出那个文件夹，再读需要的文件。",
		"约定文件：topic.md 选题；script.md 口播脚本；公众号文章/<标题>.md 已转写文章，配图在 公众号文章/images/；publish-package.json 只放标题和 tags，不写平台长文案；*.mp4/*.mov 成片（_subtitled 为烧录版）；*.srt/*.ass 字幕；*_3x4.png *_4x3.png *_16x9.png 封面。",
		"读或改这些内容，用系统自带的列文件、读文件、写文件工具。不要为了看一集再调插件工具。",
		"写或改 script.md 必须遵循用户的脚本规则（人设）：先用 oil_script_rules 读取；还没配置时主动问清语气、结构和禁忌，再用 oil_script_rules 存下来。",
		`插件工具只做文件做不到的事：配置工作台、按约定建文件夹、绑/开 Screen Studio、等导出、生成或烧录字幕、生成封面、同步已发布数据、整理文件夹名。工作台状态在 ${dataDir}/overlay.json，不是正文。`,
		"自动发布（video-publisher skill）和已发布数据回收（oil_sync_publish）都依赖 Ego Browser；能力检查显示缺失时明确告诉用户，不要假装能同步。"
	];
	if (enabledPlatforms !== void 0) lines.push(enabledPlatforms.length === 0 ? "当前没有启用发布平台。不要调用 video-publisher 或 oil_sync_publish。" : `当前启用平台：${enabledPlatformNames(enabledPlatforms)}。video-publisher 和 oil_sync_publish 只处理这些平台。`);
	if (scriptRules !== void 0 && scriptRules.trim() !== "") lines.push("", "当前脚本规则（人设）：", scriptRules.trim());
	return lines.join("\n");
}
/** Read Desktop's durable ownership for every assembly; native sessions receive no private library context. */
function registerLibraryPrompt(ctx, source) {
	return ctx.on("system-prompt/assemble", async (assembly, context, next) => {
		const id = context.agent?.session.id;
		const ownership = ctx.get("desktopWorkbenchOwnership");
		const state = id === void 0 || ownership === void 0 ? void 0 : await ownership.read().catch(() => void 0);
		if (id !== void 0 && state?.added.includes("oil-oil/dsh-oil-creator") && state.sessionBindings[id] === "oil-oil/dsh-oil-creator") assembly.sections.push({
			name: "oil:library",
			text: libraryConventionText(resolvePromptLibraryRoot(source), source.dataDir, source.cachedScriptRules, source.cachedEnabledPlatforms)
		});
		return next();
	});
}
//#endregion
//#region src/artifacts.ts
const ARTICLE_DIR = "公众号文章";
const PUBLISH_NAME = "publish-package.json";
function isPublishPackageName(name) {
	if (name.includes("auto-publish")) return false;
	if (name.startsWith("publish-package-")) return false;
	if (name.startsWith("publish_package_")) return false;
	if (name.includes("_test.video-publisher")) return false;
	return name === "publish-package.json" || name === "publisher-package.json" || name === "video-publisher-package.json" || name.endsWith(".publish-package.json") || name.endsWith("_publish-package.json") || name.endsWith(".video-publisher.json") || name.endsWith(".publisher-package.json") || name.endsWith(".publish.json");
}
function pickPublishPackage(names) {
	if (names.includes("publish-package.json")) return PUBLISH_NAME;
	const candidates = names.filter((name) => isPublishPackageName(name));
	if (candidates.length === 0) return void 0;
	const score = (name) => {
		if (name.endsWith(".publish-package.json") || name.endsWith("_publish-package.json")) return 3;
		if (name.includes("publisher-package")) return 2;
		if (name.includes("video-publisher")) return 1;
		return 0;
	};
	return [...candidates].sort((left, right) => score(right) - score(left))[0];
}
function isDraftArticleName(name) {
	return /\.(source|wechat|processed|source-check)(\.|$)/.test(name) || /_(source|processed|source-check)\.md$/.test(name);
}
function pickArticleFile(names) {
	const markdown = names.filter((name) => name.endsWith(".md"));
	return markdown.filter((name) => !isDraftArticleName(name))[0] ?? markdown[0];
}
function isSubtitledVideoName(name) {
	return name.includes("_subtitled") || name.includes("_带字幕") || name.includes("subtitled");
}
async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
//#endregion
//#region src/publishStatus.ts
const FILE_TO_PLATFORM = Object.fromEntries([...PUBLISH_PLATFORMS.map((platform) => [platform, platform]), ["wechat_channels", "wechat"]]);
function anyPlatformPublished(publish) {
	return PUBLISH_PLATFORMS.some((key) => publish[key].status === "published");
}
function emptyPublish() {
	const result = {};
	for (const platform of PUBLISH_PLATFORMS) result[platform] = {
		status: "unpublished",
		source: "none"
	};
	return result;
}
function emptyBurn() {
	return { status: "idle" };
}
function isPublishMark(value) {
	return value === "unpublished" || value === "draft" || value === "published";
}
function isPublishPlatform(value) {
	return PUBLISH_PLATFORMS.includes(value);
}
function mapPublisherStatus(raw) {
	const value = raw.trim().toLowerCase();
	if (value === "published" || value === "live" || value === "posted") return "published";
	if (value === "ready" || value === "draft" || value === "prepared") return "draft";
	return "unpublished";
}
function pickAutoPublishName(names) {
	if (names.includes("auto-publish.json")) return "auto-publish.json";
	return names.find((name) => name.endsWith(".auto-publish.json"));
}
function platformFromField(field, fallback) {
	if (typeof field === "string") return {
		status: mapPublisherStatus(field),
		source: "publisher"
	};
	if (typeof field !== "object" || field === null) return {
		status: fallback,
		source: "publisher"
	};
	const record = field;
	const status = typeof record.status === "string" ? mapPublisherStatus(record.status) : fallback;
	const url = typeof record.url === "string" && record.url.trim() !== "" ? record.url.trim() : void 0;
	return url === void 0 ? {
		status,
		source: "publisher"
	} : {
		status,
		source: "publisher",
		url
	};
}
function publishFromAutoPublish(value) {
	const result = emptyPublish();
	if (typeof value !== "object" || value === null) return result;
	const publisher = value.publisher;
	if (typeof publisher !== "object" || publisher === null) return result;
	const platforms = publisher.platforms;
	if (typeof platforms !== "object" || platforms === null) return result;
	for (const [rawKey, field] of Object.entries(platforms)) {
		const key = FILE_TO_PLATFORM[rawKey];
		if (key === void 0) continue;
		result[key] = platformFromField(field, "unpublished");
	}
	return result;
}
function mergePublish(file, overlay) {
	if (overlay === void 0) return file;
	const result = {};
	for (const key of PUBLISH_PLATFORMS) {
		result[key] = file[key];
		const over = overlay[key];
		if (over === void 0) continue;
		const source = over.syncedAt === void 0 ? "overlay" : "sync";
		result[key] = {
			status: over.status,
			source,
			...copyOverlayFields(over)
		};
	}
	return result;
}
function decodeOverlayPublish(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const source = raw;
	const next = {};
	for (const key of PUBLISH_PLATFORMS) {
		const field = source[key];
		if (typeof field !== "object" || field === null) continue;
		const record = field;
		if (!isPublishMark(record.status)) continue;
		const entry = { status: record.status };
		if (typeof record.url === "string" && record.url.trim() !== "") entry.url = record.url.trim();
		if (typeof record.remoteId === "string" && record.remoteId.trim() !== "") entry.remoteId = record.remoteId.trim();
		if (typeof record.views === "number" && Number.isFinite(record.views)) entry.views = record.views;
		if (typeof record.likes === "number" && Number.isFinite(record.likes)) entry.likes = record.likes;
		if (typeof record.comments === "number" && Number.isFinite(record.comments)) entry.comments = record.comments;
		if (typeof record.syncedAt === "number" && Number.isFinite(record.syncedAt)) entry.syncedAt = record.syncedAt;
		next[key] = entry;
	}
	return Object.keys(next).length === 0 ? void 0 : next;
}
function decodeBurnJob(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	if (record.status !== "running" && record.status !== "done" && record.status !== "error") return;
	const next = { status: record.status };
	if (typeof record.startedAt === "number" && Number.isFinite(record.startedAt)) next.startedAt = record.startedAt;
	if (typeof record.output === "string" && record.output !== "") next.output = record.output;
	if (typeof record.error === "string" && record.error !== "") next.error = record.error;
	if (typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0) next.pid = record.pid;
	return next;
}
function patchOverlayPublish(current, platform, status, url) {
	const next = { ...current };
	const previous = current?.[platform];
	const entry = {
		status,
		...previous === void 0 ? {} : copyOverlayMetrics(previous)
	};
	if (status === "published" && url !== void 0 && url.trim() !== "") entry.url = url.trim();
	else if (previous?.url !== void 0 && status === "published") entry.url = previous.url;
	next[platform] = entry;
	return next;
}
function copyOverlayMetrics(over) {
	const next = {};
	if (over.remoteId !== void 0) next.remoteId = over.remoteId;
	if (over.views !== void 0) next.views = over.views;
	if (over.likes !== void 0) next.likes = over.likes;
	if (over.comments !== void 0) next.comments = over.comments;
	if (over.syncedAt !== void 0) next.syncedAt = over.syncedAt;
	return next;
}
function copyOverlayFields(over) {
	const next = {};
	if (over.url !== void 0) next.url = over.url;
	if (over.remoteId !== void 0) next.remoteId = over.remoteId;
	if (over.views !== void 0) next.views = over.views;
	if (over.likes !== void 0) next.likes = over.likes;
	if (over.comments !== void 0) next.comments = over.comments;
	if (over.syncedAt !== void 0) next.syncedAt = over.syncedAt;
	return next;
}
async function readFolderPublish(folderPath, names) {
	const name = pickAutoPublishName(names ?? await readdir(folderPath).catch(() => []));
	if (name === void 0) return emptyPublish();
	try {
		return publishFromAutoPublish(JSON.parse(await readFile(join(folderPath, name), "utf8")));
	} catch {
		return emptyPublish();
	}
}
//#endregion
//#region src/catalog.ts
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})_(.+)$/;
const SKIP_DIRS = /* @__PURE__ */ new Set([
	".dsh-oil-creator",
	".oil-cover",
	"公众号文章"
]);
function formatDay(now) {
	return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function readableTitle(title) {
	return title.trim().replace(/[\\/:*?"<>|\n\r]/g, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
function folderNameForTitle(title, now) {
	const safe = readableTitle(title);
	if (safe === "") throw new Error("empty title");
	return `${formatDay(now)}_${safe}`;
}
async function createContentFolder(libraryRoot, title, now = /* @__PURE__ */ new Date()) {
	const root = await stat(libraryRoot).catch(() => void 0);
	if (root === void 0 || !root.isDirectory()) throw new Error("library root missing");
	const base = folderNameForTitle(title, now);
	let id = base;
	let suffix = 2;
	while (true) {
		const folderPath = join(libraryRoot, id);
		if (!await stat(folderPath).then(() => true, () => false)) {
			await mkdir(folderPath);
			return {
				id,
				folderPath
			};
		}
		id = `${base}-${suffix}`;
		suffix += 1;
	}
}
function folderDateAndTitle(folderName) {
	const matched = DATE_PREFIX.exec(folderName);
	if (matched === null || matched[1] === void 0 || matched[2] === void 0) return { title: folderName };
	return {
		date: matched[1],
		title: matched[2]
	};
}
function folderDateMs(date) {
	if (date === void 0) return void 0;
	const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (matched === null) return void 0;
	const year = Number(matched[1]);
	const month = Number(matched[2]);
	const day = Number(matched[3]);
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return void 0;
	const value = new Date(year, month - 1, day).getTime();
	return Number.isFinite(value) ? value : void 0;
}
function hasCover(item) {
	return item.covers["3x4"] !== void 0 || item.covers["4x3"] !== void 0 || item.covers["16x9"] !== void 0;
}
function sameCalendarDay(a, b) {
	const left = new Date(a);
	const right = new Date(b);
	return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}
function hasSubtitle(item) {
	return item.subtitles.srt !== void 0 || item.subtitles.ass !== void 0 || item.subtitles.transcript !== void 0 || item.videoSubtitled !== void 0;
}
function pipelineOf(item) {
	if (item.hasPublishPackage) return "packaged";
	if (hasCover(item)) return "covered";
	if (hasSubtitle(item)) return "subtitled";
	return "raw";
}
function workflowOf(item, overlay) {
	if (anyPlatformPublished(item.publish)) return "live";
	if (item.videoRaw !== void 0 || item.videoSubtitled !== void 0) {
		if (hasSubtitle(item) && hasCover(item)) return "publish";
		return "finish";
	}
	if (item.studioPath !== void 0 || overlay?.studioPath !== void 0) return "cut";
	if (overlay?.waitingForExport === true) return "finish";
	if (overlay?.readyToRecord === true) return "record";
	return "idle";
}
function countsOf(items) {
	let cover = 0;
	let subtitle = 0;
	let article = 0;
	for (const item of items) {
		if (hasCover(item)) cover += 1;
		if (hasSubtitle(item)) subtitle += 1;
		if (item.hasArticle) article += 1;
	}
	return {
		total: items.length,
		cover,
		subtitle,
		article
	};
}
function matchesFilter(item, filter) {
	if (filter === "cover") return hasCover(item);
	if (filter === "subtitle") return hasSubtitle(item);
	if (filter === "article") return item.hasArticle;
	return true;
}
function matchesQuery(item, query) {
	const needle = query.trim().toLowerCase();
	if (needle === "") return true;
	return item.title.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle) || item.tags.some((tag) => tag.toLowerCase().includes(needle));
}
async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return;
	}
}
function stringArrayField(value, key) {
	if (typeof value !== "object" || value === null) return [];
	const field = value[key];
	if (!Array.isArray(field)) return [];
	return field.filter((item) => typeof item === "string" && item.length > 0);
}
async function scanFolder(libraryRoot, folderName, overlay) {
	const folderPath = join(libraryRoot, folderName);
	const info = await stat(folderPath).catch(() => void 0);
	if (info === void 0 || !info.isDirectory()) return void 0;
	if (SKIP_DIRS.has(folderName) || folderName.startsWith(".")) return void 0;
	const names = (await readdir(folderPath, { withFileTypes: true })).map((entry) => entry.name);
	const { date, title: folderTitle } = folderDateAndTitle(folderName);
	const covers = {};
	const cover3x4 = names.find((name) => name.endsWith("_3x4.png"));
	const cover4x3 = names.find((name) => name.endsWith("_4x3.png"));
	const cover16x9 = names.find((name) => name.endsWith("_16x9.png"));
	if (cover3x4 !== void 0) covers["3x4"] = join(folderPath, cover3x4);
	if (cover4x3 !== void 0) covers["4x3"] = join(folderPath, cover4x3);
	if (cover16x9 !== void 0) covers["16x9"] = join(folderPath, cover16x9);
	const subtitles = {};
	const srt = names.find((name) => name.endsWith(".srt"));
	const ass = names.find((name) => name.endsWith(".ass"));
	if (srt !== void 0) subtitles.srt = join(folderPath, srt);
	if (ass !== void 0) subtitles.ass = join(folderPath, ass);
	const workDir = names.find((name) => name.endsWith(".subtitle-work"));
	if (workDir !== void 0) {
		const transcript = join(folderPath, workDir, "subtitle-transcript.json");
		const fallback = join(folderPath, workDir, "transcript.json");
		if (await fileExists(transcript)) subtitles.transcript = transcript;
		else if (await fileExists(fallback)) subtitles.transcript = fallback;
	}
	let videoRaw;
	let videoRawMtime = Number.NEGATIVE_INFINITY;
	let videoSubtitled;
	let videoSubtitledMtime = Number.NEGATIVE_INFINITY;
	for (const name of names) {
		if (!name.endsWith(".mp4") && !name.endsWith(".mov")) continue;
		const path = join(folderPath, name);
		const mtime = await fileMtime(path) ?? Number.NEGATIVE_INFINITY;
		if (isSubtitledVideoName(name)) {
			if (mtime >= videoSubtitledMtime) {
				videoSubtitled = path;
				videoSubtitledMtime = mtime;
			}
		} else if (mtime >= videoRawMtime) {
			videoRaw = path;
			videoRawMtime = mtime;
		}
	}
	const packageName = pickPublishPackage(names);
	const packagePath = packageName === void 0 ? void 0 : join(folderPath, packageName);
	const packageJson = packagePath === void 0 ? void 0 : await readJson(packagePath);
	const title = overlay.items[folderName]?.title ?? folderTitle;
	const tags = [
		...stringArrayField(packageJson, "xhsTopics"),
		...stringArrayField(packageJson, "douyinTopics"),
		...stringArrayField(packageJson, "bilibiliTags"),
		...stringArrayField(packageJson, "wechatTags")
	].filter((tag, index, all) => all.indexOf(tag) === index);
	const folderDate = folderDateMs(date);
	const createdMs = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
	const recordedAt = folderDate === void 0 ? createdMs : sameCalendarDay(folderDate, createdMs) ? createdMs : folderDate;
	const overlayItem = overlay.items[folderName];
	const studioInFolder = names.find((name) => name.endsWith(".screenstudio"));
	const studioPath = overlayItem?.studioPath ?? (studioInFolder === void 0 ? void 0 : join(folderPath, studioInFolder));
	let articlePath;
	if (names.includes("公众号文章")) {
		const articleFile = pickArticleFile(await readdir(join(folderPath, ARTICLE_DIR)).catch(() => []));
		if (articleFile !== void 0) articlePath = join(folderPath, ARTICLE_DIR, articleFile);
	}
	const draft = {
		id: folderName,
		folderPath,
		title,
		recordedAt,
		createdMs,
		covers,
		subtitles,
		hasPublishPackage: packageJson !== void 0,
		hasArticle: articlePath !== void 0,
		waitingForExport: overlayItem?.waitingForExport === true,
		...overlayItem?.exportTimedOut === true ? { exportTimedOut: true } : {},
		tags,
		...date === void 0 ? {} : { date },
		...videoRaw === void 0 ? {} : { videoRaw },
		...videoSubtitled === void 0 ? {} : { videoSubtitled },
		...studioPath === void 0 ? {} : { studioPath },
		...articlePath === void 0 ? {} : { articlePath },
		publish: mergePublish(await readFolderPublish(folderPath, names), overlayItem?.publish),
		burn: overlayItem?.burn ?? emptyBurn(),
		subtitleJob: overlayItem?.subtitleJob ?? emptyBurn(),
		coverJob: overlayItem?.coverJob ?? emptyBurn()
	};
	return {
		...draft,
		pipeline: pipelineOf(draft),
		workflow: workflowOf(draft, overlay.items[folderName])
	};
}
async function fileExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
async function fileMtime(path) {
	if (path === void 0) return void 0;
	return (await stat(path).catch(() => void 0))?.mtimeMs;
}
async function scanLibrary(libraryRoot, overlay) {
	const root = await stat(libraryRoot).catch(() => void 0);
	if (root === void 0 || !root.isDirectory()) return [];
	const entries = await readdir(libraryRoot, { withFileTypes: true });
	const items = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const item = await scanFolder(libraryRoot, entry.name, overlay);
		if (item !== void 0) items.push(item);
	}
	items.sort((left, right) => {
		if (left.recordedAt !== right.recordedAt) return right.recordedAt - left.recordedAt;
		if (left.createdMs !== right.createdMs) return right.createdMs - left.createdMs;
		return basename(right.folderPath).localeCompare(basename(left.folderPath), "zh");
	});
	return items;
}
async function readTopicNote(folderPath) {
	try {
		return await readFile(join(folderPath, "topic.md"), "utf8");
	} catch {
		return "";
	}
}
async function writeTopicNote(folderPath, text) {
	const path = join(folderPath, "topic.md");
	if (text.trim() === "") {
		await unlink(path).catch(() => void 0);
		return;
	}
	const body = text.endsWith("\n") ? text : `${text}\n`;
	await writeFile(path, body, "utf8");
}
async function readScript(folderPath) {
	try {
		return await readFile(join(folderPath, "script.md"), "utf8");
	} catch {
		return "";
	}
}
async function writeScript(folderPath, text) {
	const path = join(folderPath, "script.md");
	if (text.trim() === "") {
		await unlink(path).catch(() => void 0);
		return;
	}
	const body = text.endsWith("\n") ? text : `${text}\n`;
	await writeFile(path, body, "utf8");
}
async function readArticle(path) {
	if (path === void 0) return "";
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}
async function readPublishCopy(folderPath) {
	const packageName = pickPublishPackage(await readdir(folderPath).catch(() => []));
	if (packageName === void 0) return "";
	const value = await readJson(join(folderPath, packageName));
	if (typeof value !== "object" || value === null) return "";
	const record = value;
	const parts = [];
	for (const key of [
		"title",
		"bilibiliDescription",
		"douyinDescription",
		"wechatDescription"
	]) {
		const field = record[key];
		if (typeof field === "string" && field.length > 0) parts.push(field);
	}
	return parts.join("\n\n");
}
function formatCueClock(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return "";
	const total = Math.floor(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const rest = total % 60;
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}
function cuesFromSegments(segments) {
	const cues = [];
	for (const segment of segments) {
		if (typeof segment !== "object" || segment === null) continue;
		const row = segment;
		const text = typeof row.text === "string" ? row.text.trim() : "";
		if (text === "") continue;
		const start = typeof row.start === "number" ? row.start : typeof row.startTime === "number" ? row.startTime : void 0;
		const at = start === void 0 ? void 0 : formatCueClock(start);
		cues.push(at === void 0 || at === "" ? { text } : {
			text,
			at
		});
	}
	return cues;
}
function cuesFromTranscript(value) {
	if (Array.isArray(value)) return cuesFromSegments(value);
	if (typeof value !== "object" || value === null) return [];
	const record = value;
	if (Array.isArray(record.segments)) return cuesFromSegments(record.segments);
	const text = typeof record.text === "string" ? record.text.trim() : "";
	return text === "" ? [] : [{ text }];
}
const ASS_DRAWING = /\\p\d/;
const ASS_VECTOR = /^(?:m|l|b)\s+-?\d/i;
const ASS_SKIP_STYLES = /* @__PURE__ */ new Set([
	"captionbox",
	"progresslabel",
	"progressfill"
]);
function assCueText(parts) {
	const style = (parts[3] ?? "").trim().toLowerCase();
	const name = (parts[4] ?? "").trim().toLowerCase();
	if (ASS_SKIP_STYLES.has(style) || ASS_SKIP_STYLES.has(name)) return void 0;
	const original = parts.slice(9).join(",");
	if (ASS_DRAWING.test(original)) return void 0;
	const text = original.replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n").replace(/\\n/g, "\n").trim();
	if (text === "" || ASS_VECTOR.test(text)) return void 0;
	return text;
}
function cuesFromAss(raw) {
	const cues = [];
	for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		if (!line.startsWith("Dialogue:")) continue;
		const parts = line.slice(9).trim().split(",");
		if (parts.length < 10) continue;
		const text = assCueText(parts);
		if (text === void 0) continue;
		const at = formatAssClock(parts[1] ?? "");
		cues.push(at === void 0 ? { text } : {
			text,
			at
		});
	}
	return cues;
}
function formatAssClock(stamp) {
	const matched = /^(\d+):(\d{2}):(\d{2})/.exec(stamp.trim());
	if (matched === null || matched[1] === void 0 || matched[2] === void 0 || matched[3] === void 0) return;
	const hours = Number(matched[1]);
	const minutes = matched[2];
	const seconds = matched[3];
	if (hours > 0) return `${hours}:${minutes}:${seconds}`;
	return `${Number(minutes)}:${seconds}`;
}
function cuesFromSrt(raw) {
	const blocks = raw.replace(/^\uFEFF/, "").split(/\n{2,}/);
	const cues = [];
	for (const block of blocks) {
		const lines = block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
		let at;
		const texts = [];
		for (const line of lines) {
			const stamp = /^(\d{2}):(\d{2}):(\d{2})[,.]/.exec(line);
			if (stamp !== null) {
				const hours = stamp[1];
				const minutes = stamp[2];
				const seconds = stamp[3];
				if (hours !== void 0 && minutes !== void 0 && seconds !== void 0) at = hours === "00" ? `${Number(minutes)}:${seconds}` : `${Number(hours)}:${minutes}:${seconds}`;
				continue;
			}
			if (/^\d+$/.test(line)) continue;
			if (line.startsWith("Dialogue:") || line.startsWith("Style:") || line.startsWith("Format:")) continue;
			texts.push(line.replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n"));
		}
		const text = texts.join("\n").trim();
		if (text === "") continue;
		cues.push(at === void 0 ? { text } : {
			text,
			at
		});
	}
	return cues;
}
function subtitlePaths(item) {
	return [
		item.subtitles.srt,
		item.subtitles.transcript,
		item.subtitles.ass
	].filter((path) => path !== void 0);
}
async function cuesFromFile(path) {
	try {
		const raw = await readFile(path, "utf8");
		if (path.endsWith(".json")) return cuesFromTranscript(JSON.parse(raw));
		if (path.endsWith(".ass")) return cuesFromAss(raw);
		return cuesFromSrt(raw);
	} catch {
		return [];
	}
}
async function readSubtitleCues(item) {
	for (const path of subtitlePaths(item)) {
		const cues = await cuesFromFile(path);
		if (cues.length > 0) return cues;
	}
	return [];
}
async function readSubtitleText(item) {
	return (await readSubtitleCues(item)).map((cue) => cue.text).join("\n");
}
function coverPathOf(item) {
	return item.covers["3x4"] ?? item.covers["4x3"] ?? item.covers["16x9"];
}
//#endregion
//#region src/runtimePaths.ts
function venvPythonCandidates(skillDir, platform = process.platform) {
	if (platform === "win32") return [join(skillDir, ".venv", "Scripts", "python.exe"), join(skillDir, ".venv", "Scripts", "python3.exe")];
	return [join(skillDir, ".venv", "bin", "python3"), join(skillDir, ".venv", "bin", "python")];
}
function systemPythonCommand(platform = process.platform) {
	return platform === "win32" ? "python" : "python3";
}
async function resolveVenvPython(skillDir, platform = process.platform) {
	for (const path of venvPythonCandidates(skillDir, platform)) if (await pathExists(path)) return path;
}
function pathEnvValue(env) {
	const path = env.PATH ?? env.Path;
	return typeof path === "string" ? path : "";
}
function extraBinDirs(platform, home = homedir(), env = process.env) {
	const dirs = [join(home, ".local", "bin"), join(home, "bin")];
	if (platform === "win32") {
		const local = env.LOCALAPPDATA ?? env.LocalAppData ?? join(home, "AppData", "Local");
		dirs.push(join(local, "Programs"));
		return dirs;
	}
	if (home === homedir()) dirs.push("/usr/local/bin", "/opt/homebrew/bin");
	return dirs;
}
function egoInstallCandidates(platform, home = homedir(), env = process.env) {
	if (platform === "darwin") {
		const local = [join(home, "Applications", "ego lite.app"), join(home, "Applications", "Ego Lite.app")];
		if (home !== homedir()) return local;
		return [
			"/Applications/ego lite.app",
			"/Applications/Ego Lite.app",
			...local
		];
	}
	if (platform === "win32") {
		const local = env.LOCALAPPDATA ?? env.LocalAppData ?? join(home, "AppData", "Local");
		const programFiles = env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		return [
			join(local, "Programs", "ego lite", "ego-browser.exe"),
			join(local, "Programs", "Ego Lite", "ego-browser.exe"),
			join(programFiles, "ego lite", "ego-browser.exe"),
			join(programFiles, "Ego Lite", "ego-browser.exe"),
			join(programFilesX86, "ego lite", "ego-browser.exe")
		];
	}
	return [];
}
//#endregion
//#region src/processAlive.ts
function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function pidCommand(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return void 0;
	try {
		const command = execFileSync("ps", [
			"-p",
			String(pid),
			"-o",
			"command="
		], {
			encoding: "utf8",
			timeout: 500
		}).trim();
		return command === "" ? void 0 : command;
	} catch {
		return;
	}
}
function jobPidMatches(pid, fragments) {
	if (pid === void 0) return false;
	if (!pidAlive(pid)) return false;
	const command = pidCommand(pid);
	if (command === void 0) return false;
	return fragments.some((fragment) => command.includes(fragment));
}
function jobPidStillOurs(pid, fragment) {
	return jobPidMatches(pid, [fragment]);
}
async function waitForPidExit(pid, fragments, timeoutMs = 2e3, intervalMs = 50) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (!jobPidMatches(pid, fragments)) return true;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return !jobPidMatches(pid, fragments);
}
async function terminateOwnedProcess(pid, fragments, termTimeoutMs = 2e3, killTimeoutMs = 1e3) {
	if (pid === void 0 || !jobPidMatches(pid, fragments)) return true;
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	await waitForPidExit(pid, fragments, termTimeoutMs);
	if (jobPidMatches(pid, fragments)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
		await waitForPidExit(pid, fragments, killTimeoutMs);
	}
	return !jobPidMatches(pid, fragments);
}
//#endregion
//#region src/subtitle.ts
function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function subtitleInstallCommand(skillDir) {
	return `git clone https://github.com/oil-oil/oil-subtitle ${shellQuote(skillDir)} && bash ${shellQuote(join(skillDir, "setup.sh"))}`;
}
async function resolveSubtitleSkill(skillDir = process.env.OIL_SUBTITLE_SKILL ?? defaultSubtitleSkillDir(), platform = process.platform) {
	const root = await stat(skillDir).catch(() => void 0);
	if (root === void 0 || !root.isDirectory()) throw new Error(`未发现 oil-subtitle。执行 ${subtitleInstallCommand(skillDir)} 后重试。`);
	const setup = join(skillDir, "setup.sh");
	const python = await resolveVenvPython(skillDir, platform);
	const preview = join(skillDir, "scripts/preview_editor.py");
	const burn = join(skillDir, "scripts/burn_subtitles.py");
	const prepare = join(skillDir, "scripts/prepare_subtitles.py");
	const review = join(skillDir, "scripts/review_subtitles.py");
	if (python === void 0 || !await pathExists(setup) || !await pathExists(preview) || !await pathExists(burn) || !await pathExists(prepare) || !await pathExists(review)) throw new Error(`已发现 oil-subtitle 目录，但尚未完成 setup.sh。执行 bash "${setup}" 后重试。`);
	return {
		root: skillDir,
		python
	};
}
function parseSrtClock(stamp) {
	const matched = /(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(stamp.trim());
	if (matched === null) return void 0;
	const hours = Number(matched[1]);
	const minutes = Number(matched[2]);
	const seconds = Number(matched[3]);
	const millis = Number((matched[4] ?? "0").padEnd(3, "0").slice(0, 3));
	if (![
		hours,
		minutes,
		seconds,
		millis
	].every((value) => Number.isFinite(value))) return void 0;
	return hours * 3600 + minutes * 60 + seconds + millis / 1e3;
}
function srtToSegments(raw) {
	const blocks = raw.replace(/^\uFEFF/, "").split(/\n{2,}/);
	const segments = [];
	for (const block of blocks) {
		const lines = block.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
		let start;
		let end;
		const texts = [];
		for (const line of lines) {
			const range = /^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/.exec(line);
			if (range !== null && range[1] !== void 0 && range[2] !== void 0) {
				start = parseSrtClock(range[1]);
				end = parseSrtClock(range[2]);
				continue;
			}
			if (/^\d+$/.test(line)) continue;
			texts.push(line.replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n"));
		}
		const text = texts.join("\n").trim();
		if (text === "" || start === void 0 || end === void 0) continue;
		segments.push({
			start,
			end,
			text
		});
	}
	return segments;
}
function workDirOf(item) {
	if (item.subtitles.transcript !== void 0) return dirname(item.subtitles.transcript);
	const video = item.videoRaw ?? item.videoSubtitled;
	const stem = video === void 0 ? item.id : basename(video, extname(video));
	return join(item.folderPath, `${stem}.subtitle-work`);
}
async function uniqueSubtitledPath(folderPath, stem) {
	let name = `${stem}_subtitled.mp4`;
	let suffix = 2;
	while (await pathExists(join(folderPath, name))) {
		name = `${stem}_subtitled-${suffix}.mp4`;
		suffix += 1;
	}
	return join(folderPath, name);
}
async function ensurePreviewTranscript(item) {
	const work = workDirOf(item);
	const preview = join(work, "preview-transcript.json");
	const candidates = [
		item.subtitles.transcript,
		join(work, "subtitle-transcript.json"),
		join(work, "transcript.json"),
		preview
	];
	for (const path of candidates) if (path !== void 0 && await pathExists(path)) return path;
	if (item.subtitles.srt === void 0) throw new Error("no subtitle draft");
	await mkdir(work, { recursive: true });
	const raw = await readFile(item.subtitles.srt, "utf8");
	await writeFile(preview, `${JSON.stringify({ segments: srtToSegments(raw) }, null, 2)}\n`);
	return preview;
}
async function pickPreviewLaunch(item) {
	const video = item.videoRaw ?? item.videoSubtitled;
	if (video === void 0) throw new Error("no video to preview");
	const manifest = join(workDirOf(item), "subtitle-manifest.json");
	if (await pathExists(manifest)) return {
		args: [manifest],
		video
	};
	return {
		args: [video, await ensurePreviewTranscript(item)],
		video
	};
}
async function newerOrEqual(left, right) {
	const leftInfo = await stat(left).catch(() => void 0);
	const rightInfo = await stat(right).catch(() => void 0);
	if (leftInfo === void 0) return false;
	if (rightInfo === void 0) return true;
	return leftInfo.mtimeMs >= rightInfo.mtimeMs;
}
async function pickBurnLaunch(item) {
	const video = item.videoRaw;
	if (video === void 0) throw new Error("no raw video to burn");
	const stem = basename(video, extname(video));
	const output = await uniqueSubtitledPath(item.folderPath, stem);
	const work = workDirOf(item);
	const preview = join(work, "preview-transcript.json");
	const transcript = item.subtitles.transcript ?? (await pathExists(preview) ? preview : void 0);
	const srt = item.subtitles.srt;
	if (srt !== void 0 && (transcript === void 0 || await newerOrEqual(srt, transcript)) && srt !== void 0) return {
		args: [
			"--video",
			video,
			"--srt-input",
			srt,
			"--output",
			output
		],
		output
	};
	if (transcript !== void 0) {
		const args = [
			"--video",
			video,
			"--transcript",
			transcript,
			"--output",
			output
		];
		const chapters = join(dirname(transcript), "subtitle-chapters.json");
		if (await pathExists(chapters)) args.push("--chapters", chapters);
		return {
			args,
			output
		};
	}
	throw new Error("no subtitle draft");
}
function spawnPython(python, script, args, extraEnv) {
	const env = { ...process.env };
	delete env.DASHSCOPE_API_KEY;
	delete env.ZENMUX_API_KEY;
	if (extraEnv !== void 0) Object.assign(env, extraEnv);
	return spawn(python, [script, ...args], {
		env,
		stdio: [
			"ignore",
			"ignore",
			"pipe"
		],
		detached: true
	});
}
async function findFreePort(start = 8765, end = 8785) {
	for (let port = start; port < end; port += 1) if (await portIsFree(port)) return port;
	throw new Error("no free preview port");
}
function portIsFree(port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.once("error", () => {
			resolve(false);
		});
		server.listen(port, "127.0.0.1", () => {
			server.close(() => {
				resolve(true);
			});
		});
	});
}
async function waitHttp(url, timeoutMs, signal) {
	const started = Date.now();
	let last;
	while (Date.now() - started < timeoutMs) {
		signal.throwIfAborted();
		try {
			const response = await fetch(url, { signal });
			if (response.ok) return;
			last = response.status;
		} catch (cause) {
			last = cause;
		}
		await sleep$1(200, signal);
	}
	throw new Error(`preview did not start: ${String(last)}`);
}
function sleep$1(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
//#endregion
//#region src/generate.ts
async function resolveCoverSkill(skillDir = process.env.OIL_COVER_SKILL ?? defaultCoverSkillDir(), platform = process.platform) {
	const script = join(skillDir, "scripts/generate_oil_cover.py");
	if (!await pathExists(script)) throw new Error("未安装 oil-cover。执行 git clone https://github.com/oil-oil/oil-cover ~/.agents/skills/oil-cover 后重试。");
	return {
		root: skillDir,
		python: await resolveVenvPython(skillDir, platform) ?? systemPythonCommand(platform),
		script
	};
}
async function pickSubtitleWorkflow(item, skillRoot) {
	const video = item.videoRaw ?? item.videoSubtitled;
	if (video === void 0) throw new Error("no video to transcribe");
	const work = workDirOf(item);
	await mkdir(work, { recursive: true });
	const transcript = join(work, "transcript.json");
	const reviewed = join(work, "reviewed-transcript.json");
	const prepared = join(work, "subtitle-transcript.json");
	const chapters = join(work, "subtitle-chapters.json");
	const manifest = join(work, "subtitle-manifest.json");
	const cache = join(work, "cache");
	return {
		output: prepared,
		steps: [
			{
				script: join(skillRoot, "scripts/bailian_transcribe.py"),
				args: [
					video,
					"--output",
					transcript,
					"--raw-output",
					join(work, "bailian_asr.json"),
					"--language",
					"zh"
				],
				output: transcript,
				env: "subtitle"
			},
			{
				script: join(skillRoot, "scripts/review_subtitles.py"),
				args: [
					"--video",
					video,
					"--transcript",
					transcript,
					"--output",
					reviewed,
					"--report",
					join(work, "subtitle-review.json"),
					"--frames-dir",
					join(work, "review-frames")
				],
				output: reviewed,
				env: "subtitle"
			},
			{
				script: join(skillRoot, "scripts/prepare_subtitles.py"),
				args: [
					"--transcript",
					reviewed,
					"--video",
					video,
					"--output",
					prepared,
					"--chapters-output",
					chapters,
					"--manifest-output",
					manifest,
					"--work-dir",
					cache,
					"--resume"
				],
				output: prepared,
				env: "none"
			}
		]
	};
}
async function pickCoverLaunch(item, title) {
	const video = item.videoRaw ?? item.videoSubtitled;
	if (video === void 0) throw new Error("no video to cover");
	const args = [
		"--video",
		video,
		"--title",
		(title?.trim() === "" ? void 0 : title?.trim()) ?? item.title,
		"--output-root",
		item.folderPath
	];
	const subtitle = item.subtitles.srt ?? item.subtitles.transcript;
	if (subtitle !== void 0) args.push("--subtitle", subtitle);
	const stem = basename(video, extname(video));
	return {
		args,
		output: join(item.folderPath, `${stem}_3x4.png`)
	};
}
//#endregion
//#region src/capabilities.ts
function defaultFindSkillDir(skillName, home = homedir()) {
	return skillDirCandidates(skillName, home).find((candidate) => existsSync(join(candidate, "SKILL.md")));
}
function capability(state, required, detail, path) {
	return path === void 0 ? {
		state,
		required,
		detail
	} : {
		state,
		required,
		detail,
		path
	};
}
async function libraryCapability(path) {
	const info = await stat(path).catch(() => void 0);
	if (info === void 0 || !info.isDirectory()) return capability("missing", true, "内容目录不存在，需要先选择或创建目录。", path);
	return await access(path, constants.R_OK | constants.W_OK).then(() => true, () => false) ? capability("ready", true, "内容目录可读写。", path) : capability("missing", true, "内容目录存在，但当前进程没有读写权限。", path);
}
async function screenStudioCapability(platform, home) {
	if (platform !== "darwin") return capability("unsupported", false, "Screen Studio 仅支持 macOS；录制绑定和自动剪辑不可用，其他内容管理能力仍可使用。");
	const candidates = [join(home, "Applications", "Screen Studio.app")];
	if (home === homedir()) candidates.unshift("/Applications/Screen Studio.app");
	for (const path of candidates) if (await access(path).then(() => true, () => false)) return capability("ready", false, "已发现 Screen Studio，可绑定工程和自动剪辑。", path);
	return capability("missing", false, "未发现 Screen Studio；绑定工程、自动剪辑（screen-studio-editor）不可用。");
}
async function subtitleCapability(path, platform) {
	const info = await stat(path).catch(() => void 0);
	if (info === void 0 || !info.isDirectory()) return capability("missing", false, `未发现 oil-subtitle；执行 ${subtitleInstallCommand(path)} 后重试。`, path);
	try {
		return capability("ready", false, "已发现字幕工作流。", (await resolveSubtitleSkill(path, platform)).root);
	} catch {
		return capability("missing", false, `已发现 oil-subtitle 目录，但尚未完成 setup.sh；执行 bash "${join(path, "setup.sh")}" 后重试。字幕生成和预览暂不可用。`, path);
	}
}
async function coverCapability(path, platform) {
	try {
		return capability("ready", false, "已发现封面工作流。", (await resolveCoverSkill(path, platform)).root);
	} catch {
		return capability("missing", false, "未发现 oil-cover；封面生成不可用。", path);
	}
}
function credentialCapability(secret, label) {
	return secret.configured ? capability("ready", false, `${label}凭据已配置。`) : capability("missing", false, `${label}凭据未配置。`);
}
function skillCapability(findSkillDir, skillName) {
	const found = findSkillDir(skillName);
	return found === void 0 ? capability("missing", false, `未发现 ${skillName}。`) : capability("ready", false, `已发现 ${skillName}。`, found);
}
async function findExecutable(command, env = process.env, platform = process.platform, home = homedir()) {
	const pathValue = pathEnvValue(env);
	const extensions = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)] : [""];
	const mode = platform === "win32" ? constants.F_OK : constants.X_OK;
	const directories = [...pathValue.split(delimiter).filter(Boolean), ...extraBinDirs(platform, home, env)];
	for (const directory of directories) for (const extension of extensions) {
		const fileName = platform === "win32" && extension !== "" ? `${command}${extension}` : command;
		const path = join(directory, fileName);
		if (await access(path, mode).then(() => true, () => false)) return path;
	}
}
async function findEgo(platform, env, home) {
	const cli = await findExecutable("ego-browser", env, platform, home);
	if (cli !== void 0) return {
		path: cli,
		kind: "cli"
	};
	for (const path of egoInstallCandidates(platform, home, env)) if (await access(path).then(() => true, () => false)) return {
		path,
		kind: "app"
	};
}
function egoCapability(found) {
	if (found === void 0) return capability("missing", false, "未发现 Ego Browser；自动发布和发布数据回收不可用。");
	if (found.kind === "app") return capability("missing", false, "已发现 Ego Lite 应用，但 PATH 里没有 ego-browser 命令；把 CLI 加到 PATH 后再试。", found.path);
	return capability("ready", false, "已发现 Ego Browser，可自动发布和回收发布数据。", found.path);
}
function recommendationsOf(capabilities) {
	const recommendations = [];
	if (capabilities.library.state !== "ready") recommendations.push("先选择一个可读写的内容目录。");
	if (capabilities.screenStudio.state === "missing") recommendations.push("需要录屏和自动剪辑时再安装 Screen Studio（screen.studio，仅 macOS）。");
	if (capabilities.subtitleSkill.state !== "ready") {
		const installedPath = capabilities.subtitleSkill.path;
		recommendations.push(capabilities.subtitleSkill.detail.includes("尚未完成 setup.sh") && installedPath !== void 0 ? `字幕：bash "${join(installedPath, "setup.sh")}"` : installedPath === void 0 ? "字幕：git clone https://github.com/oil-oil/oil-subtitle ~/.agents/skills/oil-subtitle && bash ~/.agents/skills/oil-subtitle/setup.sh" : `字幕：${subtitleInstallCommand(installedPath)}`);
	}
	if (capabilities.subtitleCredential.state !== "ready") recommendations.push("字幕 Key：到百炼控制台（https://bailian.console.aliyun.com）申请 DASHSCOPE_API_KEY，在设置页填写。");
	if (capabilities.coverSkill.state !== "ready") recommendations.push("封面：git clone https://github.com/oil-oil/oil-cover ~/.agents/skills/oil-cover");
	if (capabilities.coverCredential.state !== "ready") recommendations.push("封面 Key：到 ZenMux（https://zenmux.ai）控制台申请 ZENMUX_API_KEY，在设置页填写。");
	if (capabilities.publishSync.state !== "ready") recommendations.push(capabilities.publishSync.detail.includes("PATH") ? "自动发布和数据回收：已装 Ego Lite，还需要把 ego-browser 加到 PATH。" : "自动发布和数据回收：安装 Ego Browser（https://lite.ego.app）并保证 PATH 里有 ego-browser，再登录各平台后台。");
	if (capabilities.editingSkill.state !== "ready") recommendations.push("自动剪辑：git clone https://github.com/oil-oil/screen-studio-editor ~/.agents/skills/screen-studio-editor");
	if (capabilities.publishSkill.state !== "ready") recommendations.push("自动发布：git clone https://github.com/oil-oil/video-publisher-skill ~/.agents/skills/video-publisher");
	if (capabilities.articleSkill.state !== "ready") recommendations.push("公众号图文：git clone https://github.com/oil-oil/oil-video-article ~/.agents/skills/oil-video-article");
	return recommendations;
}
async function inspectCreatorSetup(options) {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const findSkillDir = options.findSkillDir ?? ((name) => defaultFindSkillDir(name, home));
	const capabilities = {
		library: await libraryCapability(options.libraryRoot),
		screenStudio: await screenStudioCapability(platform, home),
		subtitleSkill: await subtitleCapability(options.subtitleSkillDir, platform),
		subtitleCredential: credentialCapability(options.settings.secrets.subtitle, "字幕"),
		coverSkill: await coverCapability(options.coverSkillDir, platform),
		coverCredential: credentialCapability(options.settings.secrets.cover, "封面"),
		publishSync: egoCapability(await findEgo(platform, env, home)),
		editingSkill: skillCapability(findSkillDir, "screen-studio-editor"),
		publishSkill: skillCapability(findSkillDir, "video-publisher"),
		articleSkill: skillCapability(findSkillDir, "oil-video-article")
	};
	return {
		platform,
		dataDir: options.dataDir,
		settings: options.settings,
		capabilities,
		recommendations: recommendationsOf(capabilities)
	};
}
//#endregion
//#region src/guide.ts
function stateMark(capability) {
	if (capability.state === "ready") return "可用";
	if (capability.state === "unsupported") return "当前系统不支持";
	return "缺失";
}
function capabilityLine(label, capability) {
	return `- ${label}：${stateMark(capability)}。${capability.detail}`;
}
function subtitleLines(capabilities) {
	const lines = [];
	if (capabilities.subtitleSkill.state !== "ready") {
		const installedPath = capabilities.subtitleSkill.path;
		const needsSetup = capabilities.subtitleSkill.detail.includes("尚未完成 setup.sh");
		lines.push(needsSetup && installedPath !== void 0 ? `- oil-subtitle 已下载但未初始化：征得用户同意后执行 \`bash "${installedPath}/setup.sh"\`，完成后重新调用 oil_creator_setup 确认。` : installedPath === void 0 ? "- 缺 oil-subtitle：征得用户同意后执行 `git clone https://github.com/oil-oil/oil-subtitle ~/.agents/skills/oil-subtitle && bash ~/.agents/skills/oil-subtitle/setup.sh`，装完重新调用 oil_creator_setup 确认。" : `- 缺 oil-subtitle：征得用户同意后按能力状态中给出的命令安装到当前配置目录 \`${installedPath}\`，装完重新调用 oil_creator_setup 确认。`);
	}
	if (capabilities.subtitleCredential.state !== "ready") lines.push("- 缺 DASHSCOPE_API_KEY：让用户到百炼控制台（https://bailian.console.aliyun.com）申请，在 设置 → 插件 → 内容工作台 填写；不要让用户把 Key 明文发到对话里。");
	return lines.length === 0 ? ["- 当前字幕能力可用。"] : lines;
}
function coverLines(capabilities) {
	const lines = [];
	if (capabilities.coverSkill.state !== "ready") lines.push("- 缺 oil-cover：征得用户同意后执行 `git clone https://github.com/oil-oil/oil-cover ~/.agents/skills/oil-cover`，装完重新调用 oil_creator_setup 确认。");
	if (capabilities.coverCredential.state !== "ready") lines.push("- 缺 ZENMUX_API_KEY：让用户到 ZenMux（https://zenmux.ai）控制台申请，在 设置 → 插件 → 内容工作台 填写；不要让用户把 Key 明文发到对话里。");
	return lines.length === 0 ? ["- 当前封面能力可用。"] : lines;
}
function publishPlatformLine(enabledPlatforms) {
	if (enabledPlatforms.length === 0) return "- 当前 enabledPlatforms 为空（[]）：不要调用 video-publisher，也不要调用 oil_sync_publish；先用 oil_creator_setup 配置启用平台，用户确认后再继续。";
	return `- 当前 enabledPlatforms：${enabledPlatforms.map((platform) => `${PUBLISH_PLATFORM_DEFINITIONS[platform].name}（${platform}）`).join("、")}。video-publisher 与 oil_sync_publish 只处理这些平台，不得上传或同步其他平台。`;
}
/**
* Build the self-bootstrap guide for the model. The text reflects the live
* capability status so the model can tell the user exactly which parts of the
* workflow work on this machine and which need installation or credentials.
*/
function creatorGuideText(status) {
	const { capabilities, settings } = status;
	const scriptRules = settings.scriptRules;
	const enabledPlatforms = settings.profile.enabledPlatforms;
	return [
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
		scriptRules === void 0 ? "- 当前没有配置脚本规则（人设）。用户第一次让你写或改脚本时，先主动问清语气、结构、禁忌和目标观众，再用 oil_script_rules 存下来，之后每次写脚本都遵循。" : "- 已配置脚本规则（人设），写或改 script.md 前先用 oil_script_rules 读取并严格遵循；用户提出新的长期偏好时，把它合并进规则再保存。",
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
		capabilities.screenStudio.state === "ready" ? "- 当前已发现 Screen Studio。用 oil_update_content 把工程绑到对应一集，oil_open_studio 打开，oil_wait_export 以 Harness 后台任务等待成片落盘。" : "- 当前没有可用的 Screen Studio：绑定工程、自动剪辑（screen-studio-editor）和等待导出都不可用。告诉用户需要先装 Screen Studio 并用它录制；如果用户用其他工具剪片，把成片文件放进这一集的文件夹即可跳过这一环节。",
		capabilities.editingSkill.state === "ready" ? "- 已发现 screen-studio-editor，用户要求清理时间线时直接使用。" : "- 缺 screen-studio-editor：征得用户同意后执行 `git clone https://github.com/oil-oil/screen-studio-editor ~/.agents/skills/screen-studio-editor`；没有它时剪辑由用户自己完成。",
		"",
		"## 自动发布与数据回收",
		"- 这两项都依赖 Ego Browser（PATH 里的 ego-browser 命令）和已登录的各平台创作者后台。",
		publishPlatformLine(enabledPlatforms),
		capabilities.publishSync.state === "ready" ? enabledPlatforms.length === 0 ? "- 已发现 Ego Browser，但当前没有启用平台，不执行自动发布和数据回收。" : "- 当前已发现 Ego Browser。上传发布走外部 skill video-publisher，停在最终发表按钮前由用户点；发布后或用户要求时用 oil_sync_publish 回收播放、赞、评论并写回工作台。" : "- 当前未发现 Ego Browser：自动发布和 oil_sync_publish 数据回收都不可用。告诉用户到 https://lite.ego.app 下载 ego lite，完成首次引导后 ego-browser 命令可用，再登录各平台创作者后台；片库、脚本、字幕、封面不受影响，不要假装能同步。",
		capabilities.publishSkill.state === "ready" ? enabledPlatforms.length === 0 ? "- 已发现 video-publisher，但当前没有启用平台，不使用它。" : "- 已发现 video-publisher。" : enabledPlatforms.length === 0 ? "- 当前没有启用平台，先配置 enabledPlatforms，再考虑安装 video-publisher。" : "- 缺 video-publisher：征得用户同意后执行 `git clone https://github.com/oil-oil/video-publisher-skill ~/.agents/skills/video-publisher`；没有它时在插件里手动标记发布状态即可。",
		"",
		"## 公众号图文",
		"- 把一期视频转成公众号文章走外部 skill oil-video-article，产物在这一集的 公众号文章/ 目录，插件负责展示，不负责生成。",
		"- 输入不绑死 Screen Studio：有 .screenstudio 工程时从无头像的屏幕轨道截帧，效果最好；只有普通成片视频时也能转写，配图直接从成片截取。",
		"- 文章语气遵循 oil-tone skill；公众号不是第五个视频平台，不参与发布状态标记。",
		capabilities.articleSkill.state === "ready" ? "- 已发现 oil-video-article，用户提到把视频整理成文章时直接使用。" : "- 缺 oil-video-article：征得用户同意后执行 `git clone https://github.com/oil-oil/oil-video-article ~/.agents/skills/oil-video-article`；不需要公众号时可以跳过这一环节。",
		"",
		"## 推进原则",
		"- 每次只推进当前缺失的下一步：选题与脚本 → 录制 → 导出成片 → 字幕 → 封面 → 发布 → 数据回收。",
		"- 任何写入（配置、整理、发布标记）先预览或说明，用户确认后再执行。",
		...status.recommendations.length === 0 ? ["- 当前没有待办的环境建议。"] : [
			"",
			"## 环境建议",
			...status.recommendations.map((item) => `- ${item}`)
		]
	].join("\n");
}
//#endregion
//#region src/organize.ts
const DATED = /^(\d{4}-\d{2}-\d{2})_(.+)$/;
const CLIPBOARD = /^Clipboard-(\d{4})(\d{2})(\d{2})-(\d{6})(?:-(\d+))?$/i;
const SCREEN = /^录屏(\d{4})-(\d{2})-(\d{2})(?:[ _.-](.+))?$/;
const FEISHU = /^飞书(\d{4})(\d{2})(\d{2})(?:-(\d+))?$/;
const CN_DATE = /^(\d{1,2})月(\d{1,2})日$/;
const STAGING = ".oil-organize-tmp";
function inferDateFromName(folderName, recordedAt) {
	const dated = DATED.exec(folderName);
	if (dated?.[1] !== void 0) return dated[1];
	const clip = CLIPBOARD.exec(folderName);
	if (clip !== null && clip[1] !== void 0 && clip[2] !== void 0 && clip[3] !== void 0) return `${clip[1]}-${clip[2]}-${clip[3]}`;
	const rec = SCREEN.exec(folderName);
	if (rec !== null && rec[1] !== void 0 && rec[2] !== void 0 && rec[3] !== void 0) return `${rec[1]}-${rec[2]}-${rec[3]}`;
	const feishu = FEISHU.exec(folderName);
	if (feishu !== null && feishu[1] !== void 0 && feishu[2] !== void 0 && feishu[3] !== void 0) return `${feishu[1]}-${feishu[2]}-${feishu[3]}`;
	const cn = CN_DATE.exec(folderName);
	if (cn !== null && cn[1] !== void 0 && cn[2] !== void 0) return `${recordedAt.getFullYear()}-${cn[1].padStart(2, "0")}-${cn[2].padStart(2, "0")}`;
	return formatDay(recordedAt);
}
function inferTitleFromName(folderName) {
	const dated = DATED.exec(folderName);
	if (dated?.[2] !== void 0) return readableTitle(dated[2]);
	const clip = CLIPBOARD.exec(folderName);
	if (clip !== null && clip[4] !== void 0) return readableTitle(`Clipboard ${clip[4]}`);
	const rec = SCREEN.exec(folderName);
	if (rec !== null) return rec[4] === void 0 ? "录屏" : readableTitle(`录屏 ${rec[4]}`);
	const feishu = FEISHU.exec(folderName);
	if (feishu !== null) return feishu[4] === void 0 ? "飞书" : readableTitle(`飞书 ${feishu[4]}`);
	return readableTitle(folderName);
}
function proposedFolderName(folderName, recordedAt) {
	const date = inferDateFromName(folderName, recordedAt);
	const title = inferTitleFromName(folderName);
	return `${date}_${title === "" ? "未命名" : title}`;
}
function reasonOf(from, to) {
	const dated = DATED.exec(from);
	const dateChanged = dated?.[1] !== to.slice(0, 10);
	const fromTitle = dated?.[2] ?? from;
	const toTitle = to.slice(11);
	const titleChanged = readableTitle(fromTitle) !== fromTitle || fromTitle !== toTitle;
	if (dateChanged && titleChanged) return "both";
	if (dateChanged) return "add-date";
	return "readable-title";
}
function uniqueName(base, used) {
	let suffix = 2;
	let next = `${base}-${suffix}`;
	while (used.has(next)) {
		suffix += 1;
		next = `${base}-${suffix}`;
	}
	return next;
}
function proposeOrganizeMoves(items, ids = []) {
	const selected = ids.length === 0 ? items : items.filter((item) => ids.includes(item.id));
	const used = new Set(items.map((item) => item.id));
	const moves = [];
	let unchanged = items.length - selected.length;
	for (const item of selected) if (proposedFolderName(item.id, new Date(item.recordedAt)) !== item.id) used.delete(item.id);
	for (const item of selected) {
		let target = proposedFolderName(item.id, new Date(item.recordedAt));
		if (target === item.id) {
			unchanged += 1;
			continue;
		}
		if (used.has(target)) target = uniqueName(target, used);
		used.add(target);
		moves.push({
			from: item.id,
			to: target,
			reason: reasonOf(item.id, target)
		});
	}
	return {
		moves,
		unchanged
	};
}
function remapOverlayItems(overlay, moves) {
	if (moves.length === 0) return overlay;
	const map = new Map(moves.map((move) => [move.from, move.to]));
	const items = {};
	for (const [id, item] of Object.entries(overlay.items)) items[map.get(id) ?? id] = item;
	return {
		...overlay,
		items
	};
}
async function previewOrganize(libraryRoot, overlay, ids = []) {
	return proposeOrganizeMoves(await scanLibrary(libraryRoot, overlay), ids);
}
async function applyOrganize(libraryRoot, overlay, ids = []) {
	const preview = await previewOrganize(libraryRoot, overlay, ids);
	if (preview.moves.length === 0) return {
		preview,
		overlay
	};
	const staging = join(libraryRoot, STAGING);
	await mkdir(staging, { recursive: true });
	try {
		for (const move of preview.moves) await rename(join(libraryRoot, move.from), join(staging, move.from));
		for (const move of preview.moves) await rename(join(staging, move.from), join(libraryRoot, move.to));
	} catch (cause) {
		for (const move of preview.moves) {
			const staged = join(staging, move.from);
			const original = join(libraryRoot, move.from);
			if (await pathExists(staged) && !await pathExists(original)) await rename(staged, original).catch(() => void 0);
		}
		throw cause;
	} finally {
		await rmdir(staging).catch(() => void 0);
	}
	return {
		preview,
		overlay: remapOverlayItems(overlay, preview.moves)
	};
}
//#endregion
//#region src/collectPublish.ts
function normalizeTitle(value) {
	return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
function titleScore(local, remote) {
	const left = normalizeTitle(local);
	const right = normalizeTitle(remote);
	if (left === "" || right === "") return 0;
	if (left === right) return 1;
	if (left.includes(right) || right.includes(left)) return .88;
	const shorter = left.length < right.length ? left : right;
	const longer = left.length < right.length ? right : left;
	let hits = 0;
	const size = Math.min(4, shorter.length);
	if (size < 2) return 0;
	for (let index = 0; index <= shorter.length - size; index += 1) if (longer.includes(shorter.slice(index, index + size))) hits += 1;
	const possible = shorter.length - size + 1;
	return possible === 0 ? 0 : hits / possible * .7;
}
function matchCollected(items, platforms, minScore = .85) {
	const matches = [];
	for (const page of platforms) {
		const used = /* @__PURE__ */ new Set();
		const keyOf = (post) => post.remoteId ?? post.url ?? post.title;
		for (const item of items) {
			let best;
			const known = item.known?.[page.platform];
			for (const post of page.items) {
				const key = keyOf(post);
				if (used.has(key)) continue;
				let score = 0;
				if (known?.remoteId !== void 0 && post.remoteId === known.remoteId) score = 1;
				else if (known?.url !== void 0 && post.url === known.url) score = .99;
				else score = titleScore(item.title, post.title);
				if (score < minScore) continue;
				if (best === void 0 || score > best.score) best = {
					id: item.id,
					platform: page.platform,
					post,
					score
				};
			}
			if (best === void 0) continue;
			used.add(keyOf(best.post));
			matches.push(best);
		}
	}
	return matches;
}
function knownFromPublish(publish) {
	const known = {};
	for (const platform of PUBLISH_PLATFORMS) {
		const row = publish[platform];
		if (row === void 0) continue;
		const next = {};
		if (row.remoteId !== void 0 && row.remoteId !== "") next.remoteId = row.remoteId;
		if (row.url !== void 0 && row.url !== "") next.url = row.url;
		if (next.remoteId !== void 0 || next.url !== void 0) known[platform] = next;
	}
	return known;
}
function collectedPostKey(item) {
	return item.remoteId ?? item.url ?? item.title;
}
function dedupeCollectedPosts(items) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of items) {
		const key = collectedPostKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
function filterCollected(result, platforms) {
	if (platforms === void 0 || platforms.length === 0) return result;
	return { collected: result.collected.filter((page) => platforms.includes(page.platform)) };
}
function filterMatchItems(items, id) {
	if (id === void 0 || id === "") return [...items];
	return items.filter((item) => item.id === id);
}
function hitsCollectTarget(item, target) {
	if (target.remoteIds?.includes(item.remoteId ?? "")) return true;
	if (target.urls !== void 0 && item.url !== void 0 && target.urls.includes(item.url)) return true;
	return titleScore(target.title, item.title) >= .85;
}
function collectedHitsTarget(items, targets) {
	if (targets.length === 0) return false;
	return items.some((item) => targets.some((target) => hitsCollectTarget(item, target)));
}
function unionCollected(previous, next) {
	if (previous === void 0) return next;
	const byPlatform = new Map(previous.collected.map((page) => [page.platform, page]));
	for (const page of next.collected) {
		const old = byPlatform.get(page.platform);
		if (old === void 0) {
			byPlatform.set(page.platform, page);
			continue;
		}
		const freshByKey = new Map(page.items.map((item) => [collectedPostKey(item), item]));
		const merged = {
			platform: page.platform,
			items: dedupeCollectedPosts([...old.items.map((item) => freshByKey.get(collectedPostKey(item)) ?? item), ...page.items])
		};
		if (page.loginRequired === true || old.loginRequired === true) merged.loginRequired = true;
		if (page.error !== void 0 && page.error !== "") merged.error = page.error;
		else if (old.error !== void 0 && old.error !== "") merged.error = old.error;
		byPlatform.set(page.platform, merged);
	}
	return { collected: [...byPlatform.values()] };
}
function mergeCollected(previous, next, replaced) {
	if (previous === void 0) return next;
	return { collected: [...previous.collected.filter((page) => {
		if (replaced === void 0 || replaced.length === 0) return false;
		return !replaced.includes(page.platform);
	}), ...next.collected] };
}
function usablePublishUrl(candidate, previous) {
	if (candidate !== void 0 && candidate !== "" && candidate !== "https://channels.weixin.qq.com/platform/post/list") return candidate;
	if (previous !== void 0 && previous !== "" && previous !== "https://channels.weixin.qq.com/platform/post/list") return previous;
}
function cacheCoversTargets(result, targets, scope = "partial") {
	if (targets === void 0 || targets.length === 0) return scope === "library";
	return collectedHitsTarget(result.collected.flatMap((page) => page.items), targets);
}
function applyMatchesToOverlay(items, matches, now = Date.now()) {
	const next = { ...items };
	for (const match of matches) {
		const current = next[match.id] ?? {};
		const publish = { ...current.publish };
		const entry = {
			status: "published",
			syncedAt: now
		};
		const nextUrl = usablePublishUrl(match.post.url, current.publish?.[match.platform]?.url);
		if (nextUrl !== void 0) entry.url = nextUrl;
		if (match.post.remoteId !== void 0 && match.post.remoteId !== "") entry.remoteId = match.post.remoteId;
		if (match.post.views !== void 0) entry.views = match.post.views;
		if (match.post.likes !== void 0) entry.likes = match.post.likes;
		if (match.post.comments !== void 0) entry.comments = match.post.comments;
		publish[match.platform] = entry;
		next[match.id] = {
			...current,
			publish
		};
	}
	return next;
}
PUBLISH_PLATFORMS.map((platform) => ({
	platform,
	url: PUBLISH_PLATFORM_DEFINITIONS[platform].collectUrl
}));
function parseCollectOutput(raw) {
	const lines = raw.split(/\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line === void 0) continue;
		try {
			const value = JSON.parse(line);
			if (typeof value !== "object" || value === null) continue;
			const collected = value.collected;
			if (!Array.isArray(collected)) continue;
			const parsed = { collected: collected.flatMap((row) => {
				if (typeof row !== "object" || row === null) return [];
				const record = row;
				const platform = record.platform;
				if (!PUBLISH_PLATFORMS.includes(platform)) return [];
				const page = {
					platform,
					items: dedupeCollectedPosts(Array.isArray(record.items) ? record.items.flatMap((item) => {
						if (typeof item !== "object" || item === null) return [];
						const post = item;
						if (typeof post.title !== "string" || post.title.trim() === "") return [];
						const next = {
							platform,
							title: post.title.trim()
						};
						if (typeof post.url === "string" && post.url !== "") next.url = post.url;
						if (typeof post.remoteId === "string" && post.remoteId !== "") next.remoteId = post.remoteId;
						if (typeof post.views === "number") next.views = post.views;
						if (typeof post.likes === "number") next.likes = post.likes;
						if (typeof post.comments === "number") next.comments = post.comments;
						return [next];
					}) : [])
				};
				if (typeof record.error === "string" && record.error !== "") page.error = record.error;
				if (record.loginRequired === true) page.loginRequired = true;
				return [page];
			}) };
			const spaceClosed = value.spaceClosed;
			if (spaceClosed === true) parsed.spaceClosed = true;
			if (spaceClosed === false) parsed.spaceClosed = false;
			return parsed;
		} catch {
			continue;
		}
	}
	throw new Error("collect-publish produced no JSON");
}
//#endregion
//#region src/collectCache.ts
const COLLECT_CACHE_TTL_MS = 9e4;
function collectCachePath(dataDir) {
	return join(dataDir, "collect-cache.json");
}
function decodeCollectCacheScope(value) {
	return value === "library" ? "library" : "partial";
}
function nextCollectCacheScope(previous, scoped) {
	if (!scoped) return "library";
	return previous === "library" ? "library" : "partial";
}
async function loadCollectCache(dataDir) {
	try {
		const raw = JSON.parse(await readFile(collectCachePath(dataDir), "utf8"));
		if (typeof raw !== "object" || raw === null) return void 0;
		const record = raw;
		if (typeof record.fetchedAt !== "number" || !Number.isFinite(record.fetchedAt)) return void 0;
		const result = parseCollectOutput(JSON.stringify({ collected: record.collected }));
		return {
			fetchedAt: record.fetchedAt,
			result,
			scope: decodeCollectCacheScope(record.scope)
		};
	} catch {
		return;
	}
}
function cacheIsFresh(fetchedAt, now = Date.now(), ttlMs = COLLECT_CACHE_TTL_MS) {
	return now - fetchedAt >= 0 && now - fetchedAt < ttlMs;
}
async function saveCollectCache(dataDir, result, options = {}) {
	const path = collectCachePath(dataDir);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({
		schemaVersion: 2,
		fetchedAt: options.now ?? Date.now(),
		scope: options.scope ?? "partial",
		collected: result.collected
	}, null, 2)}\n`, "utf8");
}
//#endregion
//#region src/collectSpaces.ts
const LEGACY_COLLECT_SPACE = "oil-collect-publish";
function defaultCollectSpaceName() {
	return `oil-collect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function collectRegistryPath(root = homedir()) {
	return join(root, ".dsh-oil-creator", "collect-spaces.json");
}
function collectRegistryPathForDataDir(dataDir) {
	return join(dataDir, "collect-spaces.json");
}
function pidIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function parseCollectRegistry(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((row) => {
			if (!row || typeof row !== "object") return [];
			const record = row;
			if (typeof record.name !== "string" || record.name.trim() === "") return [];
			if (!Number.isInteger(record.pid)) return [];
			return [{
				name: record.name.trim(),
				pid: record.pid,
				startedAt: typeof record.startedAt === "number" ? record.startedAt : 0
			}];
		});
	} catch {
		return [];
	}
}
function loadCollectRegistry(filePath) {
	try {
		return parseCollectRegistry(readFileSync(filePath, "utf8"));
	} catch {
		return [];
	}
}
function saveCollectRegistry(filePath, records) {
	mkdirSync(dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 384 });
	renameSync(temp, filePath);
}
function acquireRegistryFileLock(filePath) {
	const lockPath = `${filePath}.lock`;
	mkdirSync(dirname(filePath), { recursive: true });
	for (let attempt = 0; attempt < 80; attempt += 1) try {
		const fd = openSync(lockPath, "wx");
		writeFileSync(fd, `${process.pid}\n`);
		return () => {
			try {
				closeSync(fd);
			} catch {}
			try {
				unlinkSync(lockPath);
			} catch {}
		};
	} catch (cause) {
		if (cause.code !== "EEXIST") throw cause;
		try {
			const pid = Number(readFileSync(lockPath, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0 && !pidIsAlive(pid)) unlinkSync(lockPath);
		} catch {}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	}
	throw new Error(`collect space registry is busy: ${lockPath}`);
}
function withRegistryLock(filePath, work) {
	const release = acquireRegistryFileLock(filePath);
	try {
		return work();
	} finally {
		release();
	}
}
function registerCollectSpace(filePath, record) {
	return withRegistryLock(filePath, () => {
		const existing = loadCollectRegistry(filePath);
		const stale = existing.filter((row) => row.name !== record.name && !pidIsAlive(row.pid));
		saveCollectRegistry(filePath, [...existing.filter((row) => row.name !== record.name && pidIsAlive(row.pid)), record]);
		return stale.map((row) => row.name);
	});
}
function unregisterCollectSpace(filePath, name) {
	withRegistryLock(filePath, () => {
		saveCollectRegistry(filePath, loadCollectRegistry(filePath).filter((row) => row.name !== name));
	});
}
function collectCleanupNames(options) {
	const names = [
		...options.includeLegacy === false ? [] : [LEGACY_COLLECT_SPACE],
		...options.stale ?? [],
		...options.extra ?? []
	];
	return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}
//#endregion
//#region src/collectEgo.ts
function collectScriptPath() {
	return join(dirname(fileURLToPath(import.meta.url)), "collect-publish.mjs");
}
async function resolveCollectScript(preferred) {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		preferred,
		join(here, "collect-publish.mjs"),
		join(here, "..", "scripts", "collect-publish.mjs")
	];
	for (const path of candidates) {
		if (path === void 0) continue;
		try {
			await access(path);
			return path;
		} catch {
			continue;
		}
	}
	throw new Error("collect-publish.mjs is missing; rebuild dsh-oil-creator");
}
async function runCollectPublish(scriptPath, signal, options = {}) {
	const source = await readFile(await resolveCollectScript(scriptPath), "utf8");
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			return;
		}
		const platforms = options.platforms;
		const targets = options.targets;
		const spaceName = options.spaceName?.trim() || defaultCollectSpaceName();
		const registryPath = options.registryPath ?? collectRegistryPath();
		const cleanupNames = collectCleanupNames({
			stale: options.cleanupStale === false ? [] : loadCollectRegistry(registryPath).filter((row) => row.name !== spaceName && !pidIsAlive(row.pid)).map((row) => row.name),
			includeLegacy: options.cleanupStale !== false,
			...options.cleanupNames === void 0 ? {} : { extra: options.cleanupNames }
		});
		const env = { ...process.env };
		if (platforms !== void 0 && platforms.length > 0) env.OIL_COLLECT_PLATFORMS = platforms.join(",");
		if (targets !== void 0 && targets.length > 0) env.OIL_COLLECT_TARGETS = JSON.stringify(targets);
		env.OIL_COLLECT_SPACE = spaceName;
		env.OIL_COLLECT_KEEP = options.keepSpace === true ? "1" : "0";
		env.OIL_COLLECT_CLEANUP_STALE = options.cleanupStale === false ? "0" : "1";
		env.OIL_COLLECT_CLEANUP_NAMES = cleanupNames.join(",");
		if (options.cleanupPrefixes !== void 0 && options.cleanupPrefixes.length > 0) env.OIL_COLLECT_CLEANUP_PREFIXES = options.cleanupPrefixes.join(",");
		if (options.maxPages !== void 0) env.OIL_COLLECT_MAX_PAGES = String(options.maxPages);
		if (options.xhsScrollSteps !== void 0) env.OIL_COLLECT_XHS_SCROLL = String(options.xhsScrollSteps);
		const child = spawn("ego-browser", ["nodejs"], {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env
		});
		if (child.pid !== void 0) registerCollectSpace(registryPath, {
			name: spaceName,
			pid: child.pid,
			startedAt: Date.now()
		});
		child.stdin?.on("error", () => void 0);
		const filter = platforms !== void 0 && platforms.length > 0 ? platforms.join(",") : "";
		const prelude = [
			`var OIL_COLLECT_PLATFORMS = ${JSON.stringify(filter)};`,
			targets !== void 0 && targets.length > 0 ? `var OIL_COLLECT_TARGETS = ${JSON.stringify(targets)};` : "",
			`var OIL_COLLECT_SPACE = ${JSON.stringify(spaceName)};`,
			`var OIL_COLLECT_KEEP = ${JSON.stringify(options.keepSpace === true ? "1" : "0")};`,
			`var OIL_COLLECT_CLEANUP_STALE = ${JSON.stringify(options.cleanupStale === false ? "0" : "1")};`,
			`var OIL_COLLECT_CLEANUP_NAMES = ${JSON.stringify(cleanupNames.join(","))};`,
			options.cleanupPrefixes !== void 0 && options.cleanupPrefixes.length > 0 ? `var OIL_COLLECT_CLEANUP_PREFIXES = ${JSON.stringify(options.cleanupPrefixes.join(","))};` : "",
			options.maxPages !== void 0 ? `var OIL_COLLECT_MAX_PAGES = ${JSON.stringify(String(options.maxPages))};` : "",
			options.xhsScrollSteps !== void 0 ? `var OIL_COLLECT_XHS_SCROLL = ${JSON.stringify(String(options.xhsScrollSteps))};` : ""
		].filter(Boolean).join("\n");
		child.stdin?.end(`${prelude}\n${source}`);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const onAbort = () => {
			child.kill("SIGTERM");
		};
		signal.addEventListener("abort", onAbort, { once: true });
		child.once("error", (cause) => {
			signal.removeEventListener("abort", onAbort);
			unregisterCollectSpace(registryPath, spaceName);
			const code = cause.code;
			reject(code === "ENOENT" ? /* @__PURE__ */ new Error("ego-browser not found; install Ego Lite") : cause);
		});
		child.once("exit", (code) => {
			signal.removeEventListener("abort", onAbort);
			const raw = `${stdout}\n${stderr}`;
			if (code !== 0 && raw.trim() === "") {
				reject(/* @__PURE__ */ new Error(`ego-browser exited ${code}`));
				return;
			}
			try {
				const result = parseCollectOutput(raw);
				if (options.keepSpace === true || result.spaceClosed !== false) unregisterCollectSpace(registryPath, spaceName);
				resolve(result);
			} catch (cause) {
				const detail = raw.trim() === "" ? "" : `: ${raw.trim().slice(-500)}`;
				reject(new Error((cause instanceof Error ? cause.message : String(cause)) + detail));
			}
		});
	});
}
const NOISE_FILE = /^(?:\.DS_Store|Thumbs\.db)$/i;
const NOISE_EXT = /\.(?:tmp|temp|part|crdownload|download)$/i;
function shouldIgnoreWatchName(name) {
	if (name === null || name === "") return false;
	for (const part of name.split(/[\\/]/)) {
		if (part === "" || part === ".") continue;
		if (NOISE_FILE.test(part) || part.startsWith("._")) return true;
		if (part === ".screenstudio" || part.endsWith(".screenstudio")) return true;
		if (part === "node_modules" || part === ".git") return true;
		if (NOISE_EXT.test(part) || part.startsWith("~")) return true;
	}
	return false;
}
function createDebounced(run, waitMs) {
	let timer;
	return {
		trigger() {
			if (timer !== void 0) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = void 0;
				run();
			}, waitMs);
		},
		cancel() {
			if (timer !== void 0) clearTimeout(timer);
			timer = void 0;
		}
	};
}
function startLibraryWatch(options) {
	const debounce = createDebounced(options.onChange, options.debounceMs ?? 500);
	const watchers = [];
	const watchFileSystem = options.watchFileSystem ?? watch;
	const fingerprintOf = options.fingerprint ?? libraryFingerprint;
	let closed = false;
	let polling = false;
	let fingerprint;
	let fallback;
	let startupCheck;
	let ready = Promise.resolve();
	const poll = async () => {
		if (closed || polling) return;
		polling = true;
		try {
			const next = await fingerprintOf(options.libraryRoot, options.overlayPath);
			if (fingerprint !== void 0 && next !== fingerprint) debounce.trigger();
			fingerprint = next;
		} finally {
			polling = false;
		}
	};
	const startFallback = () => {
		if (closed || fallback !== void 0) return;
		if (startupCheck !== void 0) clearTimeout(startupCheck);
		ready = poll();
		fallback = setInterval(() => {
			poll();
		}, options.fallbackMs ?? 4e3);
		fallback.unref?.();
	};
	const attach = (path, recursive, accept, onError) => {
		try {
			const watcher = watchFileSystem(path, {
				persistent: false,
				recursive
			}, (_event, filename) => {
				const name = typeof filename === "string" ? filename : null;
				if (accept !== void 0 && !accept(name)) return;
				if (shouldIgnoreWatchName(name)) return;
				debounce.trigger();
			});
			watcher.on("error", () => {
				onError?.();
			});
			watchers.push(watcher);
			return true;
		} catch {
			return false;
		}
	};
	const recursiveLibraryWatch = attach(options.libraryRoot, true, void 0, startFallback);
	attach(options.libraryRoot, false);
	const overlayName = basename(options.overlayPath);
	const overlayWatch = attach(dirname(options.overlayPath), false, (filename) => filename === null || filename === overlayName, startFallback);
	if (!recursiveLibraryWatch || !overlayWatch) startFallback();
	else {
		ready = poll();
		ready.then(() => {
			if (closed || fallback !== void 0) return;
			startupCheck = setTimeout(() => {
				startupCheck = void 0;
				poll();
			}, options.fallbackMs ?? 4e3);
			startupCheck.unref?.();
		});
	}
	return {
		ready,
		close() {
			closed = true;
			debounce.cancel();
			if (fallback !== void 0) clearInterval(fallback);
			if (startupCheck !== void 0) clearTimeout(startupCheck);
			for (const watcher of watchers) watcher.close();
		}
	};
}
async function libraryFingerprint(libraryRoot, overlayPath) {
	const rows = [];
	const visit = async (directory, prefix) => {
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (shouldIgnoreWatchName(relative)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path, relative);
				continue;
			}
			const info = await stat(path).catch(() => void 0);
			if (info !== void 0) rows.push(`${relative}:${info.size}:${info.mtimeMs}`);
		}
	};
	await visit(libraryRoot, "");
	const overlay = await stat(overlayPath).catch(() => void 0);
	rows.push(`overlay:${overlay?.size ?? -1}:${overlay?.mtimeMs ?? -1}`);
	return rows.join("|");
}
//#endregion
//#region src/overlay.ts
const DEFAULT_ENABLED_PLATFORMS = PUBLISH_PLATFORMS;
function emptyProfile() {
	return { enabledPlatforms: [...DEFAULT_ENABLED_PLATFORMS] };
}
function decodeProfile(value) {
	if (typeof value !== "object" || value === null) return emptyProfile();
	const raw = value;
	if (Array.isArray(raw.enabledPlatforms)) return { enabledPlatforms: normalizeEnabledPlatforms(raw.enabledPlatforms) };
	return emptyProfile();
}
function overlayPath(dataDir) {
	return join(dataDir, "overlay.json");
}
function emptyOverlay() {
	return {
		schemaVersion: 1,
		items: {}
	};
}
function decodeOverlay(value) {
	if (typeof value !== "object" || value === null) return emptyOverlay();
	const raw = value;
	const items = {};
	if (raw.items !== null && typeof raw.items === "object") for (const [id, item] of Object.entries(raw.items)) {
		if (typeof item !== "object" || item === null) continue;
		const record = item;
		const next = {};
		if (typeof record.title === "string" && record.title.length > 0) next.title = record.title;
		if (record.readyToRecord === true) next.readyToRecord = true;
		if (typeof record.studioPath === "string" && record.studioPath.length > 0) next.studioPath = record.studioPath;
		if (record.waitingForExport === true) next.waitingForExport = true;
		if (record.exportTimedOut === true) next.exportTimedOut = true;
		const publish = decodeOverlayPublish(record.publish);
		if (publish !== void 0) next.publish = publish;
		const burn = decodeBurnJob(record.burn);
		if (burn !== void 0) next.burn = burn;
		const subtitleJob = decodeBurnJob(record.subtitleJob);
		if (subtitleJob !== void 0) next.subtitleJob = subtitleJob;
		const coverJob = decodeBurnJob(record.coverJob);
		if (coverJob !== void 0) next.coverJob = coverJob;
		items[id] = next;
	}
	const store = emptyOverlay();
	store.items = items;
	if (typeof raw.libraryRoot === "string" && raw.libraryRoot.length > 0) store.libraryRoot = raw.libraryRoot;
	if (typeof raw.scriptRules === "string" && raw.scriptRules.trim() !== "") store.scriptRules = raw.scriptRules.trim();
	if (typeof raw.profile === "object" && raw.profile !== null) store.profile = decodeProfile(raw.profile);
	return store;
}
async function loadOverlay(dataDir) {
	try {
		const raw = await readFile(overlayPath(dataDir), "utf8");
		return decodeOverlay(JSON.parse(raw));
	} catch {
		return emptyOverlay();
	}
}
const overlayTails = /* @__PURE__ */ new Map();
function withOverlayLock(dataDir, work) {
	const run = (overlayTails.get(dataDir) ?? Promise.resolve()).then(work, work);
	overlayTails.set(dataDir, run.then(() => void 0, () => void 0));
	return run;
}
async function saveOverlay(dataDir, store) {
	const path = overlayPath(dataDir);
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	await rename(temp, path);
}
//#endregion
//#region src/secrets.ts
const SUBTITLE_KEY_REFS = ["DASHSCOPE_API_KEY", "BAILIAN_API_KEY"];
const COVER_KEY_REFS = ["ZENMUX_API_KEY"];
function refsFor(kind) {
	return kind === "subtitle" ? SUBTITLE_KEY_REFS : COVER_KEY_REFS;
}
function primaryRef(kind) {
	return refsFor(kind)[0] ?? "DASHSCOPE_API_KEY";
}
function emptySecretView(kind) {
	return {
		kind,
		ref: primaryRef(kind),
		configured: false,
		writable: true
	};
}
function viewFromDescribe(kind, credentials) {
	for (const ref of refsFor(kind)) {
		const row = credentials[ref];
		if (row?.configured !== true) continue;
		return {
			kind,
			ref,
			configured: true,
			writable: row.writable !== false,
			...typeof row.source === "string" && row.source !== "" ? { source: row.source } : {}
		};
	}
	const primary = primaryRef(kind);
	return {
		kind,
		ref: primary,
		configured: false,
		writable: credentials[primary]?.writable !== false
	};
}
function missingSecretMessage(kind) {
	return kind === "subtitle" ? "先到设置 → 插件 → 内容工作台 填写百炼 API Key" : "先到设置 → 插件 → 内容工作台 填写 ZenMux API Key";
}
//#endregion
//#region src/secretsHost.ts
function credentialsOf(ctx) {
	const value = ctx.get("credentials");
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	if (typeof record.resolve !== "function" || typeof record.describe !== "function") return void 0;
	return record;
}
function envView(kind) {
	const configured = refsFor(kind).some((ref) => (process.env[ref] ?? "").trim() !== "");
	const view = emptySecretView(kind);
	return configured ? {
		...view,
		configured: true,
		source: "env",
		writable: false
	} : view;
}
async function describeCreatorSecrets(ctx) {
	const credentials = credentialsOf(ctx);
	if (credentials === void 0) return {
		subtitle: envView("subtitle"),
		cover: envView("cover")
	};
	const described = {};
	for (const ref of [...refsFor("subtitle"), ...refsFor("cover")]) described[ref] = await credentials.describe(ref);
	return {
		subtitle: viewFromDescribe("subtitle", described),
		cover: viewFromDescribe("cover", described)
	};
}
async function resolveCreatorSecret(ctx, kind) {
	const credentials = credentialsOf(ctx);
	if (credentials !== void 0) for (const ref of refsFor(kind)) {
		const value = (await credentials.resolve(ref))?.value.trim();
		if (value !== void 0 && value !== "") return value;
	}
	for (const ref of refsFor(kind)) {
		const value = process.env[ref]?.trim();
		if (value !== void 0 && value !== "") return value;
	}
}
function secretEnv(kind, value) {
	return { [kind === "subtitle" ? "DASHSCOPE_API_KEY" : "ZENMUX_API_KEY"]: value };
}
//#endregion
//#region src/previewServers.ts
function previewRegistryPathForDataDir(dataDir) {
	return join(dataDir, "preview-servers.json");
}
function parsePreviewRegistry(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((row) => {
			if (!row || typeof row !== "object") return [];
			const record = row;
			if (typeof record.id !== "string" || record.id.trim() === "") return [];
			if (typeof record.url !== "string" || typeof record.port !== "number") return [];
			if (!Number.isInteger(record.pid)) return [];
			return [{
				id: record.id,
				url: record.url,
				port: record.port,
				pid: record.pid,
				startedAt: typeof record.startedAt === "number" ? record.startedAt : 0
			}];
		});
	} catch {
		return [];
	}
}
function loadPreviewRegistry(filePath) {
	try {
		return parsePreviewRegistry(readFileSync(filePath, "utf8"));
	} catch {
		return [];
	}
}
function savePreviewRegistry(filePath, records) {
	mkdirSync(dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 384 });
	renameSync(temp, filePath);
}
function livePreviewRecord(records, id) {
	return records.find((row) => row.id === id && jobPidStillOurs(row.pid, "preview_editor"));
}
function upsertPreviewRecord(filePath, record) {
	const next = loadPreviewRegistry(filePath).filter((row) => row.id !== record.id && pidAlive(row.pid));
	next.push(record);
	savePreviewRegistry(filePath, next);
}
function removePreviewRecord(filePath, id) {
	savePreviewRegistry(filePath, loadPreviewRegistry(filePath).filter((row) => row.id !== id));
}
//#endregion
//#region src/thumbs.ts
function thumbName(id, sourcePath) {
	const digest = createHash("sha1").update(sourcePath).digest("hex").slice(0, 10);
	return `${id.replace(/[^\w.-]+/g, "_")}-${digest}.jpg`;
}
async function coverThumb(dataDir, id, sourcePath) {
	const empty = {
		found: false,
		mime: "",
		base64: ""
	};
	if (sourcePath === void 0) return empty;
	const source = await stat(sourcePath).catch(() => void 0);
	if (source === void 0 || !source.isFile()) return empty;
	const dir = join(dataDir, "thumbs");
	await mkdir(dir, { recursive: true });
	const dest = join(dir, thumbName(id, sourcePath));
	const cached = await stat(dest).catch(() => void 0);
	if (cached === void 0 || cached.mtimeMs < source.mtimeMs) {
		if (spawnSync("sips", [
			"-s",
			"format",
			"jpeg",
			"-Z",
			"360",
			sourcePath,
			"--out",
			dest
		], { encoding: "utf8" }).status !== 0) return empty;
	}
	try {
		return {
			found: true,
			mime: "image/jpeg",
			base64: (await readFile(dest)).toString("base64")
		};
	} catch {
		return empty;
	}
}
//#endregion
//#region src/articleServe.ts
const IMAGE_MIME = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif"
};
function resolveArticleFile(root, urlPath) {
	let rel = urlPath.split("?")[0] ?? "";
	try {
		rel = decodeURIComponent(rel);
	} catch {
		return;
	}
	rel = rel.replace(/^\/+/, "");
	if (rel === "" || rel.includes("\0")) return void 0;
	const base = resolve(root);
	const candidate = resolve(base, rel);
	if (candidate !== base && !candidate.startsWith(base + sep)) return void 0;
	if (IMAGE_MIME[extname(candidate).toLowerCase()] === void 0) return void 0;
	return candidate;
}
async function startArticleServer(root) {
	const port = await findFreePort(9e3, 9099);
	const server = createServer$1((request, response) => {
		response.setHeader("Access-Control-Allow-Origin", "*");
		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405);
			response.end();
			return;
		}
		const file = resolveArticleFile(root, request.url ?? "/");
		if (file === void 0) {
			response.writeHead(404);
			response.end();
			return;
		}
		stat(file).then((info) => {
			if (!info.isFile()) {
				response.writeHead(404);
				response.end();
				return;
			}
			const mime = IMAGE_MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
			response.writeHead(200, {
				"Content-Type": mime,
				"Content-Length": info.size,
				"Cache-Control": "private, max-age=3600"
			});
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			createReadStream(file).pipe(response);
		}, () => {
			response.writeHead(404);
			response.end();
		});
	});
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolveListen();
		});
	});
	server.unref();
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () => {
			server.close();
		}
	};
}
//#endregion
//#region src/videoServe.ts
const MIME = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm"
};
function playbackOf(item) {
	if (item.videoSubtitled !== void 0) return {
		path: item.videoSubtitled,
		kind: "subtitled"
	};
	if (item.videoRaw !== void 0) return {
		path: item.videoRaw,
		kind: "raw"
	};
}
function parseByteRange(header, size) {
	if (header === void 0 || size <= 0) return void 0;
	const matched = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (matched === null) return void 0;
	const rawStart = matched[1] ?? "";
	const rawEnd = matched[2] ?? "";
	if (rawStart === "" && rawEnd === "") return void 0;
	if (rawStart === "") {
		const suffix = Number(rawEnd);
		if (!Number.isFinite(suffix) || suffix <= 0) return void 0;
		return {
			start: Math.max(0, size - suffix),
			end: size - 1
		};
	}
	const start = Number(rawStart);
	const end = rawEnd === "" ? size - 1 : Number(rawEnd);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return;
	return {
		start,
		end: Math.min(end, size - 1)
	};
}
async function startVideoServer(path) {
	const info = await stat(path);
	if (!info.isFile()) throw new Error("video is not a file");
	const mime = MIME[extname(path).toLowerCase()] ?? "video/mp4";
	const port = await findFreePort(8900, 8999);
	const server = createServer$1((request, response) => {
		response.setHeader("Access-Control-Allow-Origin", "*");
		response.setHeader("Access-Control-Allow-Headers", "Range");
		response.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405);
			response.end();
			return;
		}
		const range = parseByteRange(request.headers.range, info.size);
		if (range === void 0) {
			response.writeHead(200, {
				"Content-Type": mime,
				"Content-Length": info.size,
				"Accept-Ranges": "bytes"
			});
			if (request.method === "HEAD") {
				response.end();
				return;
			}
			createReadStream(path).pipe(response);
			return;
		}
		const length = range.end - range.start + 1;
		response.writeHead(206, {
			"Content-Type": mime,
			"Content-Length": length,
			"Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
			"Accept-Ranges": "bytes"
		});
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		createReadStream(path, {
			start: range.start,
			end: range.end
		}).pipe(response);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolve();
		});
	});
	server.unref();
	return {
		url: `http://127.0.0.1:${port}/video${extname(path).toLowerCase()}`,
		port,
		close: () => {
			server.close();
		}
	};
}
//#endregion
//#region src/service.ts
const OIL_CREATOR_SERVICE = "oilCreator";
var OilCreatorService = class extends TypertRemoteService {
	libraryRoot;
	dataDir;
	subtitleSkillDirConfig;
	coverSkillDirConfig;
	cache;
	cachedScriptRules;
	cachedEnabledPlatforms;
	catalogRevision = 0;
	watchClose;
	watchedRoot;
	exportWaiters = /* @__PURE__ */ new Map();
	previews = /* @__PURE__ */ new Map();
	videos = /* @__PURE__ */ new Map();
	articles = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, OIL_CREATOR_SERVICE);
		this.libraryRoot = resolveUserPath(config.libraryRoot);
		this.dataDir = resolveUserPath(resolveDataDir(config));
		this.subtitleSkillDirConfig = config.subtitleSkillDir;
		this.coverSkillDirConfig = config.coverSkillDir;
		loadOverlay(this.dataDir).then((overlay) => {
			this.rememberOverlay(overlay);
		});
		ctx.effect(() => async () => {
			this.stopWatch();
			this.stopExportWaiters();
			await this.stopServers();
		}, "oil-creator: library watch");
	}
	subtitleSkillDir() {
		return resolveSkillDir(this.subtitleSkillDirConfig, "oil-subtitle", process.env.OIL_SUBTITLE_SKILL);
	}
	coverSkillDir() {
		return resolveSkillDir(this.coverSkillDirConfig, "oil-cover", process.env.OIL_COVER_SKILL);
	}
	async stopServers() {
		for (const session of this.videos.values()) session.close();
		this.videos.clear();
		for (const session of this.articles.values()) session.close();
		this.articles.clear();
		const registryPath = previewRegistryPathForDataDir(this.dataDir);
		const recorded = loadPreviewRegistry(registryPath);
		const recordedByPid = new Map(recorded.map((record) => [record.pid, record]));
		const remaining = /* @__PURE__ */ new Map();
		const seen = /* @__PURE__ */ new Set();
		for (const preview of [...this.previews.values(), ...recorded]) {
			if (seen.has(preview.pid)) continue;
			seen.add(preview.pid);
			if (jobPidStillOurs(preview.pid, "preview_editor")) try {
				process.kill(preview.pid, "SIGTERM");
				await waitForPidExit(preview.pid, ["preview_editor"]);
				if (jobPidStillOurs(preview.pid, "preview_editor")) {
					process.kill(preview.pid, "SIGKILL");
					await waitForPidExit(preview.pid, ["preview_editor"], 1e3);
				}
			} catch {}
			if (pidAlive(preview.pid) && (pidCommand(preview.pid) === void 0 || jobPidStillOurs(preview.pid, "preview_editor"))) {
				const record = recordedByPid.get(preview.pid);
				if (record !== void 0) remaining.set(record.id, record);
			}
		}
		this.previews.clear();
		savePreviewRegistry(registryPath, [...remaining.values()]);
	}
	invalidateCatalog() {
		this.cache = void 0;
		this.catalogRevision += 1;
	}
	stopWatch() {
		this.watchClose?.();
		this.watchClose = void 0;
		this.watchedRoot = void 0;
	}
	stopExportWaiters() {
		for (const waiter of this.exportWaiters.values()) waiter.abort();
		this.exportWaiters.clear();
	}
	subtitleSkill() {
		return resolveSubtitleSkill(this.subtitleSkillDir());
	}
	coverSkill() {
		return resolveCoverSkill(this.coverSkillDir());
	}
	ensureWatch(libraryRoot) {
		if (this.watchedRoot === libraryRoot && this.watchClose !== void 0) return;
		this.stopWatch();
		this.watchedRoot = libraryRoot;
		try {
			mkdirSync(this.dataDir, { recursive: true });
		} catch {}
		this.watchClose = startLibraryWatch({
			libraryRoot,
			overlayPath: overlayPath(this.dataDir),
			onChange: () => {
				this.invalidateCatalog();
			}
		}).close;
	}
	async scanned() {
		return withOverlayLock(this.dataDir, async () => {
			let overlay = await loadOverlay(this.dataDir);
			const libraryRoot = overlay.libraryRoot ?? this.libraryRoot;
			this.rememberOverlay(overlay);
			this.ensureWatch(libraryRoot);
			const reconciled = await reconcileOverlayBurns(overlay);
			if (reconciled !== void 0) {
				overlay = reconciled;
				await saveOverlay(this.dataDir, overlay);
				this.invalidateCatalog();
			}
			if (this.cache?.libraryRoot === libraryRoot) return {
				overlay,
				libraryRoot,
				items: this.cache.items
			};
			const items = await scanLibrary(libraryRoot, overlay);
			this.cache = {
				libraryRoot,
				items
			};
			return {
				overlay,
				libraryRoot,
				items
			};
		});
	}
	async getRevision(_request, signal) {
		signal.throwIfAborted();
		if (this.watchClose === void 0) await this.scanned();
		return { revision: this.catalogRevision };
	}
	async listContents(request, signal) {
		signal.throwIfAborted();
		const { overlay, libraryRoot, items: scanned } = await this.scanned();
		const items = scanned.filter((item) => matchesFilter(item, request.filter) && matchesQuery(item, request.query));
		return {
			settings: await this.settingsOf(libraryRoot, overlay),
			items,
			counts: countsOf(scanned),
			revision: this.catalogRevision
		};
	}
	async getContent(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		return {
			...item,
			publishCopy: await readPublishCopy(item.folderPath),
			topicNote: await readTopicNote(item.folderPath),
			script: await readScript(item.folderPath),
			article: await readArticle(item.articlePath),
			secrets: await describeCreatorSecrets(this.ctx)
		};
	}
	async getCoverThumb(request, signal) {
		signal.throwIfAborted();
		const folderId = request.id.split("::")[0] ?? request.id;
		const ratio = request.id.split("::")[1];
		const item = await this.find(folderId);
		const path = ratio === "3x4" || ratio === "4x3" || ratio === "16x9" ? item?.covers[ratio] : item === void 0 ? void 0 : coverPathOf(item);
		return coverThumb(this.dataDir, request.id, path);
	}
	async getVideoPlayback(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		const picked = item === void 0 ? void 0 : playbackOf(item);
		if (picked === void 0) return {
			found: false,
			url: "",
			kind: "raw"
		};
		const existing = this.videos.get(request.id);
		if (existing !== void 0 && existing.path === picked.path) return {
			found: true,
			url: existing.url,
			kind: picked.kind
		};
		existing?.close();
		const session = await startVideoServer(picked.path);
		this.videos.set(request.id, {
			url: session.url,
			path: picked.path,
			close: session.close
		});
		return {
			found: true,
			url: session.url,
			kind: picked.kind
		};
	}
	async getArticleMedia(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item?.articlePath === void 0) return {
			found: false,
			origin: ""
		};
		const root = dirname(item.articlePath);
		const existing = this.articles.get(request.id);
		if (existing !== void 0 && existing.root === root) return {
			found: true,
			origin: existing.origin
		};
		existing?.close();
		const session = await startArticleServer(root);
		this.articles.set(request.id, {
			origin: session.origin,
			root,
			close: session.close
		});
		return {
			found: true,
			origin: session.origin
		};
	}
	async getSubtitleText(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) return {
			text: "",
			cues: []
		};
		const cues = await readSubtitleCues(item);
		return {
			text: cues.length > 0 ? cues.map((cue) => cue.text).join("\n") : await readSubtitleText(item),
			cues
		};
	}
	async openContentPath(request, signal) {
		signal.throwIfAborted();
		const overlay = await loadOverlay(this.dataDir);
		const root = await realpath(overlay.libraryRoot ?? this.libraryRoot);
		const target = await realpath(request.path);
		const inside = relative(root, target);
		if (inside === ".." || inside.startsWith("../") || inside.startsWith("..\\") || isAbsolute(inside)) throw new Error("只能打开当前资料目录里的文件。");
		signal.throwIfAborted();
		await openExternalPath(target);
		return {};
	}
	async getSettings(_request, signal) {
		signal.throwIfAborted();
		const overlay = await loadOverlay(this.dataDir);
		this.rememberOverlay(overlay);
		return this.settingsOf(overlay.libraryRoot ?? this.libraryRoot, overlay);
	}
	async setLibraryRoot(request, signal) {
		signal.throwIfAborted();
		const libraryRoot = resolveUserPath(request.path);
		const info = await stat(libraryRoot).catch(() => void 0);
		if (info === void 0 || !info.isDirectory()) throw new Error(`library root is not a directory: ${libraryRoot}`);
		return withOverlayLock(this.dataDir, async () => {
			const overlay = await loadOverlay(this.dataDir);
			overlay.libraryRoot = libraryRoot;
			await saveOverlay(this.dataDir, overlay);
			this.libraryRoot = libraryRoot;
			this.stopWatch();
			this.invalidateCatalog();
			return this.settingsOf(libraryRoot, overlay);
		});
	}
	async setProfile(request, signal) {
		signal.throwIfAborted();
		return withOverlayLock(this.dataDir, async () => {
			const overlay = await loadOverlay(this.dataDir);
			overlay.profile = { enabledPlatforms: normalizeEnabledPlatforms(request.profile.enabledPlatforms) };
			await saveOverlay(this.dataDir, overlay);
			this.rememberOverlay(overlay);
			this.invalidateCatalog();
			return this.settingsOf(overlay.libraryRoot ?? this.libraryRoot, overlay);
		});
	}
	async setScriptRules(request, signal) {
		signal.throwIfAborted();
		return withOverlayLock(this.dataDir, async () => {
			const overlay = await loadOverlay(this.dataDir);
			const text = request.text.trim();
			if (text === "") delete overlay.scriptRules;
			else overlay.scriptRules = text;
			await saveOverlay(this.dataDir, overlay);
			this.rememberOverlay(overlay);
			return this.settingsOf(overlay.libraryRoot ?? this.libraryRoot, overlay);
		});
	}
	async getCreatorGuide(signal) {
		signal.throwIfAborted();
		const status = await this.getCreatorSetupStatus(signal);
		return {
			guide: creatorGuideText(status),
			status
		};
	}
	async getCapabilities(_request, signal) {
		signal.throwIfAborted();
		return { capabilities: (await this.getCreatorSetupStatus(signal)).capabilities };
	}
	async getCreatorSetupStatus(signal) {
		signal.throwIfAborted();
		const settings = await this.getSettings({}, signal);
		return inspectCreatorSetup({
			libraryRoot: settings.libraryRoot,
			dataDir: this.dataDir,
			subtitleSkillDir: this.subtitleSkillDir(),
			coverSkillDir: this.coverSkillDir(),
			settings
		});
	}
	async configureCreator(request, signal) {
		signal.throwIfAborted();
		const proposal = {};
		if (request.libraryRoot !== void 0) proposal.libraryRoot = resolveUserPath(request.libraryRoot);
		if (request.enabledPlatforms !== void 0) proposal.enabledPlatforms = normalizeEnabledPlatforms(request.enabledPlatforms);
		if (!request.apply || Object.keys(proposal).length === 0) return {
			applied: false,
			proposal,
			status: await this.getCreatorSetupStatus(signal)
		};
		if (proposal.libraryRoot !== void 0) {
			const info = await stat(proposal.libraryRoot).catch(() => void 0);
			if (info === void 0 || !info.isDirectory()) throw new Error(`library root is not a directory: ${proposal.libraryRoot}`);
		}
		await withOverlayLock(this.dataDir, async () => {
			const overlay = await loadOverlay(this.dataDir);
			if (proposal.libraryRoot !== void 0) overlay.libraryRoot = proposal.libraryRoot;
			const profile = overlay.profile ?? emptyProfile();
			if (proposal.enabledPlatforms !== void 0) profile.enabledPlatforms = [...proposal.enabledPlatforms];
			overlay.profile = profile;
			await saveOverlay(this.dataDir, overlay);
			this.rememberOverlay(overlay);
			if (proposal.libraryRoot !== void 0) {
				this.libraryRoot = proposal.libraryRoot;
				this.stopWatch();
			}
			this.invalidateCatalog();
		});
		return {
			applied: true,
			proposal,
			status: await this.getCreatorSetupStatus(signal)
		};
	}
	async setTopicNote(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		await writeTopicNote(item.folderPath, request.text);
		return this.getContent({ id: request.id }, signal);
	}
	async setScript(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		if (request.folderPath !== void 0 && request.folderPath !== item.folderPath) throw new Error("资料位置已切换，脚本草稿已保留，请重新打开对应内容。");
		signal.throwIfAborted();
		await writeScript(item.folderPath, request.text);
		return this.getContent({ id: request.id }, signal);
	}
	async organizeLibrary(request, signal) {
		signal.throwIfAborted();
		const overlay = await loadOverlay(this.dataDir);
		const libraryRoot = overlay.libraryRoot ?? this.libraryRoot;
		if (!request.apply) return previewOrganize(libraryRoot, overlay, request.ids);
		const result = await applyOrganize(libraryRoot, overlay, request.ids);
		await withOverlayLock(this.dataDir, async () => {
			const latest = await loadOverlay(this.dataDir);
			await saveOverlay(this.dataDir, remapOverlayItems(latest, result.preview.moves));
		});
		this.invalidateCatalog();
		return result.preview;
	}
	async refreshCatalog(_request, signal) {
		this.invalidateCatalog();
		return this.listContents({
			query: "",
			filter: "all"
		}, signal);
	}
	async setContentStage(request, signal) {
		signal.throwIfAborted();
		await withOverlayLock(this.dataDir, async () => {
			const overlay = await loadOverlay(this.dataDir);
			const next = { ...overlay.items[request.id] ?? {} };
			if (request.readyToRecord) next.readyToRecord = true;
			else delete next.readyToRecord;
			overlay.items[request.id] = next;
			await saveOverlay(this.dataDir, overlay);
			this.invalidateCatalog();
		});
		return this.getContent({ id: request.id }, signal);
	}
	async createContent(request, signal) {
		signal.throwIfAborted();
		const overlay = await loadOverlay(this.dataDir);
		const libraryRoot = request.libraryRoot === void 0 ? overlay.libraryRoot : resolveUserPath(request.libraryRoot);
		if (libraryRoot === void 0) throw new Error("请先在内容工作台的系统目录选择器中确认资料位置。");
		const created = await createContentFolder(libraryRoot, request.title);
		this.invalidateCatalog();
		return created;
	}
	async bindStudio(request, signal) {
		signal.throwIfAborted();
		const studioPath = await resolveStudioPath(request.path);
		return this.patchItem(request.id, (item) => {
			item.studioPath = studioPath;
		}, signal);
	}
	async setPublish(request, signal) {
		signal.throwIfAborted();
		if (!((await loadOverlay(this.dataDir)).profile?.enabledPlatforms ?? emptyProfile().enabledPlatforms).includes(request.platform)) throw new Error(`publish platform is disabled: ${request.platform}`);
		return this.patchItem(request.id, (item) => {
			item.publish = patchOverlayPublish(item.publish, request.platform, request.status, request.url);
		}, signal);
	}
	async syncPublish(request, signal) {
		signal.throwIfAborted();
		const enabledPlatforms = (await loadOverlay(this.dataDir)).profile?.enabledPlatforms ?? emptyProfile().enabledPlatforms;
		if (request.platform !== void 0 && !enabledPlatforms.includes(request.platform)) throw new Error(`publish platform is disabled: ${request.platform}`);
		const platforms = request.platform === void 0 ? enabledPlatforms : [request.platform];
		const scopedId = request.id === void 0 || request.id === "" ? void 0 : request.id;
		const cached = await loadCollectCache(this.dataDir);
		const { items } = await this.scanned();
		const scoped = filterMatchItems(items, scopedId);
		if (scopedId !== void 0 && scoped.length === 0) throw new Error(`content not found: ${scopedId}`);
		if (platforms.length === 0) return {
			matched: 0,
			platforms: []
		};
		const targets = scopedId === void 0 ? void 0 : scoped.map((item) => {
			const known = knownFromPublish(item.publish);
			const remoteIds = Object.values(known).map((row) => row.remoteId).filter((value) => value !== void 0 && value !== "");
			const urls = Object.values(known).map((row) => row.url).filter((value) => value !== void 0 && value !== "");
			const target = { title: item.title };
			if (remoteIds.length > 0) target.remoteIds = remoteIds;
			if (urls.length > 0) target.urls = urls;
			return target;
		});
		let collected;
		let fromCache = false;
		const cachedSlice = cached === void 0 ? void 0 : filterCollected(cached.result, platforms);
		const cacheCoversPlatforms = cachedSlice !== void 0 && platforms.every((platform) => cachedSlice.collected.some((page) => page.platform === platform));
		if (request.force !== true && cached !== void 0 && cacheIsFresh(cached.fetchedAt) && cacheCoversPlatforms && cacheCoversTargets(cachedSlice ?? cached.result, targets, cached.scope)) {
			collected = cachedSlice ?? cached.result;
			fromCache = true;
		} else try {
			collected = await runCollectPublish(collectScriptPath(), signal, {
				...platforms === void 0 ? {} : { platforms },
				...targets === void 0 ? {} : { targets },
				registryPath: collectRegistryPathForDataDir(this.dataDir)
			});
			const merged = scopedId === void 0 ? mergeCollected(cached?.result, collected, platforms) : unionCollected(cached?.result, collected);
			await saveCollectCache(this.dataDir, merged, { scope: nextCollectCacheScope(cached?.scope, scopedId !== void 0) });
			collected = filterCollected(merged, platforms);
		} catch (cause) {
			if (signal.aborted || cause instanceof Error && cause.name === "AbortError") throw cause;
			if (cached === void 0 || !cacheIsFresh(cached.fetchedAt) || !cacheCoversPlatforms || !cacheCoversTargets(cachedSlice ?? cached.result, targets, cached.scope)) throw cause;
			collected = cachedSlice ?? cached.result;
			fromCache = true;
		}
		const matches = matchCollected(scoped.map((item) => ({
			id: item.id,
			title: item.title,
			known: knownFromPublish(item.publish)
		})), collected.collected);
		await withOverlayLock(this.dataDir, async () => {
			const latest = await loadOverlay(this.dataDir);
			latest.items = applyMatchesToOverlay(latest.items, matches);
			await saveOverlay(this.dataDir, latest);
			this.invalidateCatalog();
		});
		const result = {
			matched: matches.length,
			platforms: collected.collected.map((page) => {
				const row = {
					platform: page.platform,
					count: page.items.length
				};
				if (page.loginRequired === true) row.loginRequired = true;
				if (page.error !== void 0 && page.error !== "") row.error = page.error;
				return row;
			})
		};
		if (fromCache) result.cached = true;
		return result;
	}
	async openSubtitlePreview(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		const registryPath = previewRegistryPathForDataDir(this.dataDir);
		const recorded = livePreviewRecord(loadPreviewRegistry(registryPath), request.id);
		const existing = this.previews.get(request.id);
		const reusable = existing !== void 0 && jobPidMatches(existing.pid, ["preview_editor"]) ? existing : recorded;
		if (reusable !== void 0) {
			this.previews.set(request.id, reusable);
			await openExternalPath(reusable.url);
			return {
				url: reusable.url,
				port: reusable.port
			};
		}
		const skill = await this.subtitleSkill();
		const launch = await pickPreviewLaunch(item);
		const port = await findFreePort();
		const child = spawnPython(skill.python, join(skill.root, "scripts/preview_editor.py"), launch.args, { PREVIEW_EDITOR_PORT: String(port) });
		const pid = child.pid;
		if (pid === void 0) throw new Error("preview failed to start");
		child.unref();
		const url = `http://127.0.0.1:${port}`;
		const record = {
			url,
			port,
			pid,
			id: request.id,
			startedAt: Date.now()
		};
		this.previews.set(request.id, record);
		upsertPreviewRecord(registryPath, record);
		try {
			await waitHttp(url, 8e3, signal);
		} catch (cause) {
			try {
				await terminateOwnedProcess(pid, ["preview_editor"]);
			} catch {}
			try {
				this.previews.delete(request.id);
			} finally {
				removePreviewRecord(registryPath, request.id);
			}
			throw cause;
		}
		await openExternalPath(url);
		return {
			url,
			port
		};
	}
	async startSubtitleBurn(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		if (item.burn.status === "running" && jobPidMatches(item.burn.pid, ["burn_subtitles.py"])) return this.getContent({ id: request.id }, signal);
		const skill = await this.subtitleSkill();
		const launch = await pickBurnLaunch(item);
		const child = spawnPython(skill.python, join(skill.root, "scripts/burn_subtitles.py"), launch.args);
		const pid = child.pid;
		if (pid === void 0) throw new Error("burn failed to start");
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = `${stderr}${String(chunk)}`.slice(-4e3);
		});
		const startedAt = Date.now();
		child.once("exit", (code) => {
			const burn = code === 0 ? {
				status: "done",
				startedAt,
				output: launch.output
			} : {
				status: "error",
				startedAt,
				output: launch.output,
				error: stderr.trim() === "" ? `burn failed: ${code}` : stderr.trim()
			};
			this.patchItem(request.id, (next) => {
				next.burn = burn;
			}, new AbortController().signal).catch(() => void 0);
		});
		child.unref();
		return this.patchItem(request.id, (next) => {
			next.burn = {
				status: "running",
				startedAt,
				output: launch.output,
				pid
			};
		}, signal);
	}
	async startSubtitleGenerate(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		if (item.subtitleJob.status === "running" && jobPidMatches(item.subtitleJob.pid, JOB_COMMAND.subtitleJob)) return this.getContent({ id: request.id }, signal);
		if (item.burn.status === "running" && jobPidMatches(item.burn.pid, JOB_COMMAND.burn)) return this.getContent({ id: request.id }, signal);
		const subtitleKey = await resolveCreatorSecret(this.ctx, "subtitle");
		if (subtitleKey === void 0) throw new Error(missingSecretMessage("subtitle"));
		const skill = await this.subtitleSkill();
		const workflow = await pickSubtitleWorkflow(item, skill.root);
		const env = { ...secretEnv("subtitle", subtitleKey) };
		return this.startChainedJob(request.id, "subtitleJob", {
			python: skill.python,
			steps: workflow.steps,
			env
		}, signal);
	}
	async startCoverGenerate(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		if (item.coverJob.status === "running" && jobPidMatches(item.coverJob.pid, ["generate_oil_cover.py"])) return this.getContent({ id: request.id }, signal);
		const key = await resolveCreatorSecret(this.ctx, "cover");
		if (key === void 0) throw new Error(missingSecretMessage("cover"));
		const skill = await this.coverSkill();
		const launch = await pickCoverLaunch(item, request.title);
		return this.startTrackedJob(request.id, "coverJob", {
			python: skill.python,
			script: skill.script,
			args: launch.args,
			output: launch.output,
			env: secretEnv("cover", key)
		}, signal);
	}
	async startChainedJob(id, field, launch, signal) {
		const first = launch.steps[0];
		if (first === void 0) throw new Error(`${field} has no steps`);
		const finalOutput = launch.steps[launch.steps.length - 1]?.output ?? first.output;
		const startedAt = Date.now();
		const runStep = (index) => {
			const step = launch.steps[index];
			if (step === void 0) throw new Error(`${field} step missing`);
			const child = spawnPython(launch.python, step.script, step.args, envForGenerateStep(step.env, launch.env));
			const pid = child.pid;
			if (pid === void 0) throw new Error(`${field} failed to start`);
			let stderr = "";
			child.stderr?.on("data", (chunk) => {
				stderr = `${stderr}${String(chunk)}`.slice(-4e3);
			});
			child.once("exit", (code) => {
				if (code !== 0) {
					const job = {
						status: "error",
						startedAt,
						output: step.output,
						error: stderr.trim() === "" ? `${field} failed: ${code}` : stderr.trim()
					};
					this.patchItem(id, (next) => {
						next[field] = job;
					}, new AbortController().signal).catch(() => void 0);
					return;
				}
				if (launch.steps[index + 1] !== void 0) {
					try {
						const nextPid = runStep(index + 1);
						this.patchItem(id, (next) => {
							next[field] = {
								status: "running",
								startedAt,
								output: finalOutput,
								pid: nextPid
							};
						}, new AbortController().signal).catch(() => void 0);
					} catch (cause) {
						const message = cause instanceof Error ? cause.message : `${field} failed`;
						this.patchItem(id, (next) => {
							next[field] = {
								status: "error",
								startedAt,
								output: step.output,
								error: message
							};
						}, new AbortController().signal).catch(() => void 0);
					}
					return;
				}
				this.patchItem(id, (next) => {
					next[field] = {
						status: "done",
						startedAt,
						output: finalOutput
					};
				}, new AbortController().signal).then(() => {
					if (field !== "subtitleJob") return;
					return this.openSubtitlePreview({ id }, new AbortController().signal);
				}, () => void 0).catch(() => void 0);
			});
			child.unref();
			return pid;
		};
		const pid = runStep(0);
		return this.patchItem(id, (next) => {
			next[field] = {
				status: "running",
				startedAt,
				output: finalOutput,
				pid
			};
		}, signal);
	}
	async startTrackedJob(id, field, launch, signal) {
		const child = spawnPython(launch.python, launch.script, launch.args, launch.env);
		const pid = child.pid;
		if (pid === void 0) throw new Error(`${field} failed to start`);
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr = `${stderr}${String(chunk)}`.slice(-4e3);
		});
		const startedAt = Date.now();
		child.once("exit", (code) => {
			const job = code === 0 ? {
				status: "done",
				startedAt,
				output: launch.output
			} : {
				status: "error",
				startedAt,
				output: launch.output,
				error: stderr.trim() === "" ? `${field} failed: ${code}` : stderr.trim()
			};
			this.patchItem(id, (next) => {
				next[field] = job;
			}, new AbortController().signal).catch(() => void 0);
		});
		child.unref();
		return this.patchItem(id, (next) => {
			next[field] = {
				status: "running",
				startedAt,
				output: launch.output,
				pid
			};
		}, signal);
	}
	async openStudio(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		if (item.studioPath === void 0) throw new Error("no Screen Studio project bound");
		if (process.platform !== "darwin") throw new Error("Screen Studio is only supported on macOS");
		await openExternalPath(item.studioPath);
		return this.getContent({ id: request.id }, signal);
	}
	async waitForExport(request, signal) {
		signal.throwIfAborted();
		const item = await this.find(request.id);
		if (item === void 0) throw new Error(`content not found: ${request.id}`);
		if (item.videoRaw !== void 0 || item.videoSubtitled !== void 0) return this.getContent({ id: request.id }, signal);
		const started = await this.patchItem(request.id, (next) => {
			next.waitingForExport = true;
			delete next.exportTimedOut;
		}, signal);
		this.exportWaiters.get(request.id)?.abort();
		const waiter = new AbortController();
		this.exportWaiters.set(request.id, waiter);
		const timeoutMs = request.timeoutMs ?? 72e5;
		waitForStableVideo(item.folderPath, timeoutMs, waiter.signal).then((found) => {
			if (waiter.signal.aborted) return;
			this.exportWaiters.delete(request.id);
			return this.patchItem(request.id, (next) => {
				if (found) {
					delete next.waitingForExport;
					delete next.exportTimedOut;
					return;
				}
				next.waitingForExport = true;
				next.exportTimedOut = true;
			}, new AbortController().signal);
		}, () => {
			this.exportWaiters.delete(request.id);
		});
		return started;
	}
	async waitForMediaJob(id, field, signal) {
		while (true) {
			signal.throwIfAborted();
			const job = (await this.getContent({ id }, signal))[field];
			if (job.status !== "running") return job;
			await sleep(400, signal);
		}
	}
	async cancelMediaJob(id, field) {
		const signal = new AbortController().signal;
		const job = (await this.getContent({ id }, signal))[field];
		if (job.status !== "running") return;
		await terminateOwnedProcess(job.pid, JOB_COMMAND[field]);
		await this.patchItem(id, (next) => {
			const current = next[field];
			if (current?.status !== "running" || current.pid !== job.pid) return;
			next[field] = {
				status: "error",
				...current.startedAt === void 0 ? {} : { startedAt: current.startedAt },
				...current.output === void 0 ? {} : { output: current.output },
				error: "cancelled"
			};
		}, signal);
	}
	async waitForExportCompletion(id, signal) {
		while (true) {
			signal.throwIfAborted();
			const detail = await this.getContent({ id }, signal);
			if (detail.videoRaw !== void 0 || detail.videoSubtitled !== void 0 || detail.exportTimedOut === true) return detail;
			await sleep(400, signal);
		}
	}
	async cancelExportWait(id) {
		this.exportWaiters.get(id)?.abort();
		this.exportWaiters.delete(id);
		await this.patchItem(id, (next) => {
			delete next.waitingForExport;
			delete next.exportTimedOut;
		}, new AbortController().signal);
	}
	async find(id) {
		const { items } = await this.scanned();
		return items.find((item) => item.id === id);
	}
	rememberOverlay(overlay) {
		this.cachedScriptRules = overlay.scriptRules;
		this.cachedEnabledPlatforms = overlay.profile?.enabledPlatforms ?? emptyProfile().enabledPlatforms;
	}
	async settingsOf(libraryRoot, overlay) {
		return {
			libraryRoot,
			profile: overlay.profile ?? emptyProfile(),
			secrets: await describeCreatorSecrets(this.ctx),
			...overlay.scriptRules === void 0 ? {} : { scriptRules: overlay.scriptRules }
		};
	}
	async patchItem(id, mutate, signal) {
		await withOverlayLock(this.dataDir, async () => {
			const overlay = await loadOverlay(this.dataDir);
			const next = { ...overlay.items[id] ?? {} };
			mutate(next);
			overlay.items[id] = next;
			await saveOverlay(this.dataDir, overlay);
			this.invalidateCatalog();
		});
		return this.getContent({ id }, signal);
	}
};
function resolveUserPath(path) {
	const expanded = expandHomePath(path);
	if (!isAbsolute(expanded)) throw new Error(`path must be absolute: ${path}`);
	return expanded;
}
function envForGenerateStep(kind, env) {
	const key = kind === "subtitle" ? "DASHSCOPE_API_KEY" : kind === "cover" ? "ZENMUX_API_KEY" : void 0;
	if (key === void 0 || env === void 0 || env[key] === void 0) return void 0;
	return { [key]: env[key] };
}
async function resolveStudioPath(path) {
	if (await stat(path).catch(() => void 0) === void 0) throw new Error("Screen Studio project missing");
	if (path.endsWith(".screenstudio")) return path;
	if (await pathExists(join(path, "project.json"))) return path;
	throw new Error("not a Screen Studio project");
}
const JOB_FIELDS = [
	"burn",
	"subtitleJob",
	"coverJob"
];
const JOB_COMMAND = {
	burn: ["burn_subtitles.py"],
	subtitleJob: [
		"bailian_transcribe.py",
		"review_subtitles.py",
		"prepare_subtitles.py"
	],
	coverJob: ["generate_oil_cover.py"]
};
function jobStarted(job) {
	return job.startedAt === void 0 ? {} : { startedAt: job.startedAt };
}
async function settleFinishedJob(job, field) {
	const output = job.output;
	const started = jobStarted(job);
	if (output !== void 0 && await pathExists(output)) return {
		status: "done",
		...started,
		output
	};
	return {
		status: "error",
		...started,
		...output === void 0 ? {} : { output },
		error: `${field} process exited`
	};
}
function recoverSubtitleJob(item, job) {
	if (job.status !== "error" || job.error !== "subtitleJob process exited") return void 0;
	const burn = item.burn;
	if (burn?.status === "running" && burn.pid !== void 0 && jobPidMatches(burn.pid, JOB_COMMAND.burn)) return {
		status: "running",
		...jobStarted(job),
		...jobStarted(burn),
		...burn.output === void 0 ? {} : { output: burn.output },
		pid: burn.pid
	};
	if (burn?.status === "done") {
		const output = burn.output ?? job.output;
		return {
			status: "done",
			...jobStarted(job),
			...jobStarted(burn),
			...output === void 0 ? {} : { output }
		};
	}
}
async function reconcileOverlayBurns(overlay) {
	let dirty = false;
	const items = { ...overlay.items };
	for (const [id, item] of Object.entries(overlay.items)) {
		let nextItem = items[id] ?? item;
		for (const field of JOB_FIELDS) {
			const job = nextItem[field];
			if (job === void 0) continue;
			if (field === "subtitleJob") {
				const recovered = recoverSubtitleJob(nextItem, job);
				if (recovered !== void 0) {
					nextItem = {
						...nextItem,
						subtitleJob: recovered
					};
					dirty = true;
					continue;
				}
			}
			if (job.status !== "running") continue;
			if (jobPidMatches(job.pid, JOB_COMMAND[field])) continue;
			nextItem = {
				...nextItem,
				[field]: await settleFinishedJob(job, field)
			};
			dirty = true;
		}
		items[id] = nextItem;
	}
	return dirty ? {
		...overlay,
		items
	} : void 0;
}
function openExternalPath(path) {
	return new Promise((resolve, reject) => {
		const command = process.platform === "darwin" ? {
			file: "open",
			args: [path]
		} : process.platform === "win32" ? {
			file: "explorer.exe",
			args: [path]
		} : {
			file: "xdg-open",
			args: [path]
		};
		const child = spawn(command.file, command.args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0 || code === null) resolve();
			else reject(/* @__PURE__ */ new Error(`${command.file} failed: ${code}`));
		});
	});
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
async function waitForStableVideo(folderPath, timeoutMs, signal) {
	const started = Date.now();
	let last = "";
	let same = 0;
	while (Date.now() - started < timeoutMs) {
		signal.throwIfAborted();
		const names = await readdir(folderPath).catch(() => []);
		let newest;
		for (const name of names) {
			if (!name.endsWith(".mp4") && !name.endsWith(".mov")) continue;
			if (isSubtitledVideoName(name)) continue;
			const path = join(folderPath, name);
			const info = await stat(path).catch(() => void 0);
			if (info === void 0 || !info.isFile() || info.size === 0) continue;
			if (newest === void 0 || info.mtimeMs > newest.mtime) newest = {
				path,
				size: info.size,
				mtime: info.mtimeMs
			};
		}
		const key = newest === void 0 ? "" : `${newest.path}:${newest.size}`;
		if (key !== "" && key === last) same += 1;
		else {
			last = key;
			same = 0;
		}
		if (same >= 4) return true;
		await sleep(2e3, signal);
	}
	return false;
}
//#endregion
//#region src/settingsHost.ts
/** Settings forms now derive discovery from the plugin's Config/entry id. */
function registerCreatorSettingsNamespace(settings) {
	return settings.configure({ auto: false });
}
//#endregion
//#region src/tools.ts
function signalOf(exec) {
	return exec.signal;
}
function compactText(title, detail) {
	return [{
		type: "text",
		text: `${title}: ${detail}`
	}];
}
function asJson(value) {
	return JSON.parse(JSON.stringify(value));
}
function present(title, rawInput) {
	return {
		card: "generic",
		title,
		kind: "other",
		rawInput
	};
}
const JSON_VALUE$1 = { type: "json" };
function registerCreatorTools(ctx, service) {
	ctx.tools.register(defineTool({
		name: "oil_creator_guide",
		description: "Self-bootstrap guide for this plugin. Call this when the user asks what this plugin does, how to use it, or when you are unsure which step comes next. Returns the full workflow (library, script rules, subtitles, covers, publish, data sync) with the live capability status, including whether Ego Browser is available for auto-publish and data collection.",
		parameters: {},
		output: {
			schema: JSON_VALUE$1,
			render: (_args, value) => {
				const capabilities = Object.values(value.status?.capabilities ?? {});
				const ready = capabilities.filter((item) => item.state === "ready").length;
				return compactText("Guide", `${ready}/${capabilities.length} capabilities ready`);
			}
		},
		presentCall: (args) => present("Creator guide", args),
		execute: (_args, exec) => service.getCreatorGuide(signalOf(exec)).then(asJson)
	}));
	ctx.tools.register(defineTool({
		name: "oil_script_rules",
		description: "Read or update the creator's script rules (persona): tone, structure, audience, and taboos that every script.md must follow. Omit text to read. Send text to save. Empty text clears. Ask the user about their persona before writing rules for the first time; merge new long-term preferences into the existing rules instead of replacing them.",
		parameters: { text: {
			type: "string",
			description: "Full script rules text. Omit to read. Empty string clears."
		} },
		output: {
			schema: JSON_VALUE$1,
			render: (_args, value) => {
				return compactText("Script rules", value.scriptRules === void 0 ? "not set" : "saved");
			}
		},
		presentCall: (args) => present("Script rules", args),
		async execute(args, exec) {
			const signal = signalOf(exec);
			if (typeof args.text !== "string") return asJson(await service.getSettings({}, signal));
			return asJson(await service.setScriptRules({ text: args.text }, signal));
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_creator_setup",
		description: "Inspect the creator workspace, optional local capabilities, credential status, and current configuration. Omit fields for a read-only diagnosis. Proposed changes are previewed unless apply=true. Only use apply=true after the user confirms the exact directory and enabled platform changes.",
		parameters: {
			apply: {
				type: "boolean",
				description: "False previews changes. True saves them after user confirmation."
			},
			libraryRoot: {
				type: "string",
				description: "Existing absolute content directory, or a path starting with ~/."
			},
			enabledPlatforms: {
				type: "array",
				items: {
					type: "string",
					enum: PUBLISH_PLATFORMS
				},
				description: "Complete list of enabled platforms. Empty disables all platforms."
			}
		},
		output: {
			schema: JSON_VALUE$1,
			render: (_args, value) => {
				const result = value;
				const capabilities = Object.values(result.status?.capabilities ?? {});
				const ready = capabilities.filter((item) => item.state === "ready").length;
				return compactText(result.applied ? "Setup applied" : "Setup checked", `${ready}/${capabilities.length} capabilities ready`);
			}
		},
		presentCall: (args) => present("Creator setup", args),
		async execute(args, exec) {
			const request = {
				apply: args.apply === true,
				...typeof args.libraryRoot === "string" ? { libraryRoot: args.libraryRoot } : {},
				...Array.isArray(args.enabledPlatforms) ? { enabledPlatforms: normalizeEnabledPlatforms(args.enabledPlatforms) } : {}
			};
			return asJson(await service.configureCreator(request, signalOf(exec)));
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_create_content",
		description: "Create an empty dated library folder named YYYY-MM-DD_title using today's date and a readable title.",
		parameters: { title: {
			type: "string",
			required: true,
			description: "Episode title. Hyphens become spaces."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					folderPath: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => compactText("Created", value.id)
		},
		presentCall: (args) => present("Create content", args),
		execute: (args, exec) => {
			if (args.title.trim() === "") throw new Error("title is required");
			return service.createContent({ title: args.title }, signalOf(exec));
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_update_content",
		description: "Write overlay-only marks for one episode: readyToRecord, bind a Screen Studio project, or set a platform publish status. To change topic.md or script.md, write those files in the episode folder with the built-in file tools.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Folder id."
			},
			readyToRecord: {
				type: "boolean",
				description: "True moves idle content to 待录制."
			},
			studioPath: {
				type: "string",
				description: "Bind a .screenstudio project to this episode."
			},
			publishPlatform: {
				type: "string",
				enum: PUBLISH_PLATFORMS,
				description: "Platform to mark. Pair with publishStatus."
			},
			publishStatus: {
				type: "string",
				enum: [
					"unpublished",
					"draft",
					"published"
				],
				description: "Per-platform publish mark stored in the plugin overlay."
			},
			publishUrl: {
				type: "string",
				description: "Optional live URL when status is published."
			}
		},
		output: {
			schema: JSON_VALUE$1,
			render: (_args, value) => {
				const record = value;
				return compactText("Updated", record.title || record.id || "");
			}
		},
		presentCall: (args) => present("Update content", args),
		async execute(args, exec) {
			const signal = signalOf(exec);
			if (args.id === "") throw new Error("id is required");
			if (args.readyToRecord !== void 0) await service.setContentStage({
				id: args.id,
				readyToRecord: args.readyToRecord
			}, signal);
			if (args.studioPath !== void 0 && args.studioPath !== "") await service.bindStudio({
				id: args.id,
				path: args.studioPath
			}, signal);
			if (args.publishPlatform !== void 0 !== (args.publishStatus !== void 0)) throw new Error("publishPlatform and publishStatus must be sent together");
			if (isPublishPlatform(args.publishPlatform) && isPublishMark(args.publishStatus)) await service.setPublish(args.publishUrl === void 0 ? {
				id: args.id,
				platform: args.publishPlatform,
				status: args.publishStatus
			} : {
				id: args.id,
				platform: args.publishPlatform,
				status: args.publishStatus,
				url: args.publishUrl
			}, signal);
			return asJson(await service.getContent({ id: args.id }, signal));
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_creator_profile",
		description: "Read or update the list of enabled publishing platforms. Omit the list to read. Send the complete list to replace it.",
		parameters: { enabledPlatforms: {
			type: "array",
			items: {
				type: "string",
				enum: PUBLISH_PLATFORMS
			},
			description: "Complete list of enabled platforms. Empty disables all platforms."
		} },
		output: {
			schema: JSON_VALUE$1,
			render: () => compactText("Profile", "saved")
		},
		presentCall: (args) => present("Creator profile", args),
		async execute(args, exec) {
			const signal = signalOf(exec);
			const current = (await service.getSettings({}, signal)).profile;
			if (!Array.isArray(args.enabledPlatforms)) return asJson(current);
			const next = { enabledPlatforms: normalizeEnabledPlatforms(args.enabledPlatforms) };
			return asJson((await service.setProfile({ profile: next }, signal)).profile);
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_organize_library",
		description: "Preview or apply library folder cleanup to YYYY-MM-DD_readable title. Adds a date from the recording/folder time when missing, and turns hyphens/underscores in titles into spaces. Never deletes files. apply=false (default) only previews. Pass ids to limit the batch.",
		parameters: {
			apply: {
				type: "boolean",
				description: "False previews. True renames folders."
			},
			ids: {
				type: "array",
				items: { type: "string" },
				description: "Optional folder ids to organize. Empty means the whole library."
			}
		},
		output: {
			schema: JSON_VALUE$1,
			render: (_args, value) => {
				const record = value;
				return compactText("Organize", `${(Array.isArray(record.moves) ? record.moves : []).length} moves`);
			}
		},
		presentCall: (args) => present("Organize library", args),
		execute: async (args, exec) => asJson(await service.organizeLibrary({
			apply: args.apply === true,
			ids: args.ids ?? []
		}, signalOf(exec)))
	}));
	ctx.tools.register(defineTool({
		name: "oil_sync_publish",
		description: "Sync published titles, URLs, and counts from logged-in creator dashboards. Pass id to update one episode only and stop paging once that title is found. Omit id to match the whole library and collect every page. Requires Ego Lite and an already-logged-in creator session. Repeats within 90 seconds reuse the last snapshot.",
		parameters: {
			id: {
				type: "string",
				description: "Folder id of one episode. Omit to sync the whole library."
			},
			platform: {
				type: "string",
				enum: PUBLISH_PLATFORMS,
				description: "Collect only this platform. Omit to visit all enabled platforms."
			},
			force: {
				type: "boolean",
				description: "Skip the 90-second cache and open creator pages again."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					matched: {
						type: "integer",
						required: true
					},
					platforms: {
						type: "json",
						required: true
					},
					cached: { type: "boolean" }
				}
			},
			render: (_args, value) => compactText("Sync publish", `${value.matched} matched`)
		},
		presentCall: (args) => present("Sync publish", args),
		execute: (args, exec) => {
			const request = {};
			if (args.id !== void 0 && args.id !== "") request.id = args.id;
			if (isPublishPlatform(args.platform)) request.platform = args.platform;
			if (args.force === true) request.force = true;
			return service.syncPublish(request, signalOf(exec));
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_open_studio",
		description: "Open the bound Screen Studio project for this episode so the user can review and export.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Folder id."
		} },
		output: {
			schema: JSON_VALUE$1,
			render: (_args, value) => {
				const record = value;
				return compactText("Open Studio", record.title || record.id || "");
			}
		},
		presentCall: (args) => present("Open Studio", args),
		execute: async (args, exec) => {
			if (args.id === "") throw new Error("id is required");
			return asJson(await service.openStudio({ id: args.id }, signalOf(exec)));
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_open_subtitle_preview",
		description: "Open the oil-subtitle preview editor in the browser for this episode (video + editable cues).",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Folder id."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: {
						type: "string",
						required: true
					},
					port: {
						type: "integer",
						required: true
					}
				}
			},
			render: (_args, value) => compactText("Subtitle preview", value.url)
		},
		presentCall: (args) => present("Subtitle preview", args),
		execute: (args, exec) => {
			if (args.id === "") throw new Error("id is required");
			return service.openSubtitlePreview({ id: args.id }, signalOf(exec));
		}
	}));
}
//#endregion
//#region src/visualReview.ts
const JSON_VALUE = { type: "json" };
const COVER_RATIOS = [
	"3x4",
	"4x3",
	"16x9"
];
function missingCoverRatios(covers) {
	return COVER_RATIOS.filter((ratio) => covers[ratio] === void 0);
}
function imageMediaType(path) {
	switch (extname(path).toLowerCase()) {
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return;
	}
}
async function prepareCoverReview(service, attachments, id, signal) {
	const detail = await service.getContent({ id }, signal);
	const missing = missingCoverRatios(detail.covers);
	if (missing.length > 0) throw new Error(`missing cover variants: ${missing.join(", ")}`);
	const candidates = COVER_RATIOS.flatMap((ratio) => {
		const path = detail.covers[ratio];
		return path === void 0 ? [] : [{
			ratio,
			path
		}];
	});
	if (candidates.length === 0) throw new Error(`no generated covers: ${id}`);
	const inputs = await Promise.all(candidates.map(async ({ path }) => {
		signal.throwIfAborted();
		const mediaType = imageMediaType(path);
		if (mediaType === void 0) throw new Error(`unsupported cover image: ${path}`);
		return {
			data: await readFile(path),
			mediaType,
			name: basename(path)
		};
	}));
	signal.throwIfAborted();
	const refs = await attachments.saveImages(inputs);
	return {
		id,
		title: detail.title,
		images: candidates.map((candidate, index) => ({
			ratio: candidate.ratio,
			attachment: refs[index]
		}))
	};
}
function reviewMarkdown(id, review, createdAt) {
	const verdict = review.verdict === "pass" ? "通过" : "需要修改";
	const rows = review.findings.length === 0 ? "- 无" : review.findings.map((finding) => {
		const suggestion = finding.suggestion?.trim();
		return `- [${finding.severity}] ${finding.asset}：${finding.issue}` + (suggestion === void 0 || suggestion === "" ? "" : `；建议：${suggestion}`);
	}).join("\n");
	return `# 视觉审查\n\n- 内容：${id}\n- 结论：${verdict}\n- 时间：${createdAt}\n\n## 总结\n\n${review.summary}\n\n## 问题清单\n\n${rows}\n`;
}
async function atomicWrite(path, content) {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(temporary, content, "utf8");
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true }).catch(() => void 0);
	}
}
async function saveVisualReview(service, id, review, signal) {
	signal.throwIfAborted();
	const detail = await service.getContent({ id }, signal);
	const missing = missingCoverRatios(detail.covers ?? {});
	if (review.verdict === "pass" && missing.length > 0) throw new Error(`cannot pass visual review; missing cover variants: ${missing.join(", ")}`);
	const createdAt = (/* @__PURE__ */ new Date()).toISOString();
	const jsonPath = join(detail.folderPath, "visual-review.json");
	const markdownPath = join(detail.folderPath, "visual-review.md");
	const record = {
		schemaVersion: 1,
		id,
		createdAt,
		...review
	};
	await atomicWrite(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
	signal.throwIfAborted();
	await atomicWrite(markdownPath, reviewMarkdown(id, review, createdAt));
	return {
		jsonPath,
		markdownPath
	};
}
function registerVisualReviewTools(ctx, service) {
	ctx.tools.register(defineTool({
		name: "oil_prepare_visual_review",
		description: "Load all generated cover variants for one episode into the multimodal model context. Inspect composition, readability, safe areas, ratio adaptation, and brand consistency, then call oil_save_visual_review.",
		parameters: { id: {
			type: "string",
			required: true,
			description: "Folder id."
		} },
		output: {
			schema: JSON_VALUE,
			render: (_args, value) => {
				const result = value;
				return [{
					type: "text",
					text: `${result.title}: cover images follow in this order: ${result.images.map((image) => image.ratio).join(", ")}`
				}, ...result.images.map((image) => ({
					type: "image",
					attachment: image.attachment
				}))];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Prepare visual review",
			kind: "other",
			rawInput: args
		}),
		execute: async (args, exec) => {
			if (args.id.trim() === "") throw new Error("id is required");
			return prepareCoverReview(service, ctx.attachments, args.id, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "oil_save_visual_review",
		description: "Persist a completed multimodal cover review into visual-review.json and visual-review.md in the episode folder. Call only after oil_prepare_visual_review and include concrete findings for each affected ratio.",
		parameters: {
			id: {
				type: "string",
				required: true,
				description: "Folder id."
			},
			verdict: {
				type: "string",
				required: true,
				enum: ["pass", "needs_changes"]
			},
			summary: {
				type: "string",
				required: true,
				description: "Concise overall review."
			},
			findings: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						severity: {
							type: "string",
							required: true,
							enum: [
								"info",
								"warning",
								"blocking"
							]
						},
						asset: {
							type: "string",
							required: true,
							description: "Affected ratio or file name."
						},
						issue: {
							type: "string",
							required: true
						},
						suggestion: { type: "string" }
					}
				}
			}
		},
		output: {
			schema: JSON_VALUE,
			render: (_args, value) => {
				return [{
					type: "text",
					text: `visual review saved: ${value.markdownPath ?? "visual-review.md"}`
				}];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Save visual review",
			kind: "other",
			rawInput: args
		}),
		execute: async (args, exec) => {
			if (args.id.trim() === "") throw new Error("id is required");
			if (args.summary.trim() === "") throw new Error("summary is required");
			const findings = args.findings.map((finding) => {
				if (finding.asset.trim() === "" || finding.issue.trim() === "") throw new Error("finding asset and issue are required");
				return {
					severity: finding.severity,
					asset: finding.asset,
					issue: finding.issue,
					...finding.suggestion === void 0 ? {} : { suggestion: finding.suggestion }
				};
			});
			return saveVisualReview(service, args.id, {
				verdict: args.verdict,
				summary: args.summary,
				findings
			}, exec.signal);
		}
	}));
}
//#endregion
//#region src/index.ts
const name = "dsh-oil-creator";
function apply(ctx, config) {
	const service = new OilCreatorService(ctx, config);
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => registerCreatorSettingsNamespace(settingsCtx.settings));
	});
	ctx.inject(["tools"], (toolsCtx) => {
		registerCreatorTools(toolsCtx, service);
	});
	ctx.inject(["tools", "jobs"], (jobsCtx) => {
		registerCreatorJobTools(jobsCtx, service);
	});
	ctx.inject(["tools", "attachments"], (visualCtx) => {
		registerVisualReviewTools(visualCtx, service);
	});
	ctx.inject(["systemPrompt"], (promptCtx) => {
		registerLibraryPrompt(promptCtx, service);
	});
	ctx.inject(["skills"], (skillsCtx) => {
		registerCreatorWorkbenchSkill(skillsCtx);
	});
}
//#endregion
export { Config, apply, name };
