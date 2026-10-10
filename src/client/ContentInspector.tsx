import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  IconBrowseOutlineRegular,
  IconCloseOutlineRegular,
  IconFolderOpenOutlineRegular,
  MarkdownText,
  Menu,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";

import { formatCount } from "../collectPublish.ts";
import { isPublishMark } from "../publishStatus.ts";
import { rewriteArticleImages } from "../articleMarkdown.ts";
import type { ArticleMediaResult, ContentDetail, PublishMark, PublishPlatform, SubtitleCue, VideoPlaybackResult, WorkflowStage } from "../types.ts";
import { CoverThumb, coverThumbRevision } from "./CoverThumb.tsx";
import type { CreatorViewFace } from "./face.ts";
import {
  useLibraryEpoch,
  useProfileEpoch,
  useSelectedContentId,
} from "./contentSelection.ts";
import type { CreatorKey } from "./locales.ts";
import { PlatformMark } from "./PlatformMark.tsx";
import { isPublishSyncDisabled, PUBLISH_UI_PLATFORMS, selectEnabledPublishPlatforms } from "./publishPlatforms.ts";
import { formatRelativeTime } from "./relativeTime.ts";
import { WORKFLOW_TONE } from "./workflowTone.ts";
import { ActionBar, ActionButton } from "./ui/ActionButton.tsx";
import { StatusPill, type StatusTone } from "./ui/StatusPill.tsx";
import { Surface } from "./ui/Surface.tsx";
import "./ContentInspector.css";

const TABS = ["overview", "video", "script", "subtitle", "article"] as const;
const INSPECTOR_WIDE_PX = 720;
type InspectorTab = (typeof TABS)[number];

const PIPELINE_STEPS = [
  { id: "topic", label: "inspector.step.topic", hint: "inspector.step.topicHint" },
  { id: "record", label: "inspector.step.record", hint: "inspector.step.recordHint" },
  { id: "cut", label: "inspector.step.cut", hint: "inspector.step.cutHint" },
  { id: "finish", label: "inspector.step.finish", hint: "inspector.step.finishHint" },
  { id: "publish", label: "inspector.step.publish" },
] as const;

type PipelineStepId = (typeof PIPELINE_STEPS)[number]["id"];

const WORKFLOW_INDEX: Record<WorkflowStage, number> = {
  idle: 0,
  record: 1,
  cut: 2,
  finish: 3,
  publish: 4,
  live: 4,
};

const PUBLISH_KEY: Record<PublishMark, CreatorKey> = {
  unpublished: "inspector.publish.unpublished",
  draft: "inspector.publish.draft",
  published: "inspector.publish.published",
};

const PUBLISH_TONE: Record<PublishMark, StatusTone> = {
  unpublished: "neutral",
  draft: "pending",
  published: "success",
};

const PUBLISH_MARKS: readonly PublishMark[] = ["unpublished", "draft", "published"];

const STAGE_KEY: Record<WorkflowStage, CreatorKey> = {
  idle: "inspector.stage.idle",
  record: "inspector.stage.record",
  cut: "inspector.stage.cut",
  finish: "inspector.stage.finish",
  publish: "inspector.stage.publish",
  live: "inspector.stage.live",
};

const TAB_KEY: Record<InspectorTab, CreatorKey> = {
  overview: "inspector.tab.overview",
  video: "inspector.tab.video",
  script: "inspector.tab.script",
  subtitle: "inspector.tab.subtitle",
  article: "inspector.tab.article",
};

function cuesFromSubtitle(nextSubtitle: { text: string; cues: SubtitleCue[] }): SubtitleCue[] {
  if (nextSubtitle.cues.length > 0) return nextSubtitle.cues;
  if (nextSubtitle.text === "") return [];
  return nextSubtitle.text.split("\n").filter((line) => line.trim() !== "").map((text) => ({ text }));
}

function friendlyError(cause: unknown, t: (key: CreatorKey) => string): string {
  if (cause instanceof Error) {
    if (cause.message.startsWith("content not found")) return t("empty.gone" as CreatorKey);
    return cause.message;
  }
  return t("empty.error" as CreatorKey);
}

function metricParts(
  row: { views?: number; likes?: number; comments?: number },
  t: (key: CreatorKey) => string,
): string[] {
  const parts: string[] = [];
  if (row.views !== undefined) {
    parts.push(t("inspector.publish.views").replace("{n}", formatCount(row.views)));
  }
  if (row.likes !== undefined) {
    parts.push(t("inspector.publish.likes").replace("{n}", formatCount(row.likes)));
  }
  if (row.comments !== undefined) {
    parts.push(t("inspector.publish.comments").replace("{n}", formatCount(row.comments)));
  }
  return parts;
}

function JobNote({ tone, children }: { tone?: "running" | "done" | "error"; children: ReactNode }) {
  return (
    <div className={tone === undefined ? "jobNote" : `jobNote ${tone}`}>
      {tone === "running" && <StateDot state="ongoing" size={12} />}
      {tone === "done" && <StateDot state="done" size={12} />}
      {tone === "error" && <StateDot state="error" size={12} />}
      {children}
    </div>
  );
}

function WorkRow({
  name,
  status,
  tone,
  actions,
}: {
  name: string;
  status: string;
  tone?: StatusTone;
  actions?: ReactNode;
}) {
  return (
    <div className="workRow">
      <div className="workMain">
        <span className="workName">{name}</span>
        <StatusPill tone={tone ?? "neutral"}>{status}</StatusPill>
      </div>
      {actions !== undefined && <ActionBar>{actions}</ActionBar>}
    </div>
  );
}

const pendingScriptDrafts = new Map<string, string>();

export type ContentInspectorProps = CreatorViewFace & {
  suspended?: boolean;
  t: (key: CreatorKey) => string;
};

export function ContentInspector({
  t,
  suspended = false,
  ready,
  getContent,
  getCoverThumb,
  getVideoPlayback,
  getArticleMedia,
  getSubtitleText,
  getSettings,
  markReadyToRecord,
  bindStudio,
  openStudio,
  setPublish,
  syncPublish,
  startSubtitleGenerate,
  startSubtitleBurn,
  startCoverGenerate,
  setScript,
  pickDirectory,
  openSubtitlePreview,
  openPath,
}: ContentInspectorProps) {
  const tabGroupId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [selectedId, setSelectedId] = useSelectedContentId();
  const libraryEpoch = useLibraryEpoch();
  const profileEpoch = useProfileEpoch();
  const [enabledPlatforms, setEnabledPlatforms] = useState<readonly PublishPlatform[] | undefined>(undefined);
  const scriptSavedRef = useRef(true);
  const loadedFolder = useRef<string | null>(null);
  const loadedId = useRef<string | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<ContentDetail | undefined>(undefined);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<InspectorTab>("overview");
  const [wide, setWide] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const [busy, setBusy] = useState<"subtitle" | "burn" | "cover" | "sync" | undefined>(undefined);
  const expectSubtitlePreview = useRef(false);
  const [syncHint, setSyncHint] = useState<string | undefined>(undefined);
  const [scriptDraft, setScriptDraft] = useState("");
  const [scriptSaved, setScriptSaved] = useState(true);
  scriptSavedRef.current = scriptSaved;
  const [videoSrc, setVideoSrc] = useState<string | undefined>(undefined);
  const [videoReady, setVideoReady] = useState(false);
  const [articleOrigin, setArticleOrigin] = useState<string | undefined>(undefined);
  const [publishMenu, setPublishMenu] = useState<PublishPlatform | null>(null);
  const [publishPending, setPublishPending] = useState<PublishPlatform | null>(null);

  useEffect(() => {
    setTab("overview");
    setActionError(undefined);

    setSyncHint(undefined);
    setScriptDraft("");
    setScriptSaved(true);
    setVideoSrc(undefined);
    setVideoReady(false);
    setArticleOrigin(undefined);
    setBusy(undefined);
    expectSubtitlePreview.current = false;
    setPublishMenu(null);
    setPublishPending(null);
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    setEnabledPlatforms(undefined);
    if (!ready()) {
      setEnabledPlatforms([]);
      return () => { cancelled = true; };
    }
    void getSettings().then((settings) => {
      if (!cancelled) setEnabledPlatforms(settings.profile.enabledPlatforms);
    }, () => {
      if (!cancelled) setEnabledPlatforms([]);
    });
    return () => { cancelled = true; };
  }, [getSettings, libraryEpoch, profileEpoch, ready]);

  useEffect(() => {
    const el = pane.current;
    if (el === null) return;
    const update = (): void => {
      setWide(el.getBoundingClientRect().width >= INSPECTOR_WIDE_PX);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { update(); });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);

  useEffect(() => {
    if (suspended) return;
    if (selectedId === null) {
      loadedId.current = null;
      setDetail(undefined);
      setCues([]);
      setError(undefined);
      return;
    }
    if (!ready()) {
      setError(t("empty.remote" as CreatorKey));
      return;
    }
    const switched = loadedId.current !== selectedId;
    let cancelled = false;
    setError(undefined);
    void Promise.all([getContent(selectedId), getSubtitleText(selectedId)]).then(
      ([nextDetail, nextSubtitle]) => {
        if (cancelled) return;
        loadedId.current = selectedId;
        setDetail(nextDetail);
        if (switched || loadedFolder.current !== nextDetail.folderPath || scriptSavedRef.current) {
          const draft = pendingScriptDrafts.get(nextDetail.folderPath) ?? nextDetail.script;
          setScriptDraft(draft);
          setScriptSaved(draft === nextDetail.script);
        }
        loadedFolder.current = nextDetail.folderPath;
        setCues(cuesFromSubtitle(nextSubtitle));
      },
      (cause: unknown) => {
        if (cancelled) return;
        setDetail(undefined);
        setCues([]);
        setError(friendlyError(cause, t));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, libraryEpoch, suspended]);

  useEffect(() => {
    if (suspended || tab !== "video" || selectedId === null || !ready()) return;
    let cancelled = false;
    setVideoReady(false);
    void getVideoPlayback(selectedId).then((next: VideoPlaybackResult) => {
      if (cancelled) return;
      setVideoSrc(next.found ? next.url : undefined);
      setVideoReady(true);
    }, () => {
      if (cancelled) return;
      setVideoSrc(undefined);
      setVideoReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, selectedId, libraryEpoch, suspended]);

  useEffect(() => {
    if (suspended || tab !== "article" || selectedId === null || !ready()) return;
    let cancelled = false;
    void getArticleMedia(selectedId).then((next: ArticleMediaResult) => {
      if (cancelled) return;
      setArticleOrigin(next.found ? next.origin : undefined);
    }, () => {
      if (!cancelled) setArticleOrigin(undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [tab, selectedId, libraryEpoch, suspended]);

  useEffect(() => {
    if (suspended || detail === undefined || scriptSaved) return;
    let cancelled = false;
    const folder = detail.folderPath;
    const timer = window.setTimeout(() => {
      void setScript(detail.id, scriptDraft, folder).then((next) => {
        if (pendingScriptDrafts.get(folder) === scriptDraft && next.script === scriptDraft) pendingScriptDrafts.delete(folder);
        if (cancelled) return;
        setDetail(next);
        setScriptSaved(scriptDraft === next.script);
      }, (cause: unknown) => {
        if (!cancelled) setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
      });
    }, 700);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [detail?.id, detail?.folderPath, scriptDraft, scriptSaved, suspended]);

  useEffect(() => {
    const running = detail?.burn.status === "running"
      || detail?.subtitleJob.status === "running"
      || detail?.coverJob.status === "running";
    if (suspended || !running || selectedId === null || !ready()) return;
    const timer = window.setInterval(() => {
      void getContent(selectedId).then((next) => { setDetail(next); });
    }, 3000);
    return () => { window.clearInterval(timer); };
  }, [selectedId, detail?.burn.status, detail?.subtitleJob.status, detail?.coverJob.status, suspended]);

  useEffect(() => {
    if (suspended || selectedId === null || detail?.subtitleJob.status !== "done" || !ready()) return;
    void getSubtitleText(selectedId).then((nextSubtitle) => {
      setCues(cuesFromSubtitle(nextSubtitle));
    });
  }, [selectedId, detail?.subtitleJob.status, suspended]);

  useEffect(() => {
    if (suspended || !expectSubtitlePreview.current || selectedId === null || !ready()) return;
    if (detail?.subtitleJob.status === "done") {
      expectSubtitlePreview.current = false;
      void openSubtitlePreview(selectedId).then(() => undefined, (cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
      });
      return;
    }
    if (detail?.subtitleJob.status === "error") expectSubtitlePreview.current = false;
  }, [selectedId, detail?.subtitleJob.status, suspended]);

  const applyPublish = (platform: PublishPlatform, status: PublishMark): void => {
    setPublishMenu(null);
    if (detail === undefined || detail.publish[platform].status === status) return;
    setPublishPending(platform);
    void setPublish(detail.id, platform, status).then((next) => {
      setDetail(next);
      setPublishPending(null);
    }, (cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
      setPublishPending(null);
    });
  };

  if (selectedId === null) return null;

  const hasVideo = detail?.videoRaw !== undefined || detail?.videoSubtitled !== undefined;
  const hasSubtitleDraft = detail?.subtitles.srt !== undefined || detail?.subtitles.transcript !== undefined;
  const canPreviewSubtitle = hasSubtitleDraft || detail?.subtitleJob.status === "done";
  const hasAnyCover = detail !== undefined
    && (detail.covers["3x4"] !== undefined || detail.covers["4x3"] !== undefined || detail.covers["16x9"] !== undefined);
  const platformSettingsPending = enabledPlatforms === undefined;
  const visiblePlatforms = platformSettingsPending ? [] : selectEnabledPublishPlatforms(enabledPlatforms);
  const publishedCount = detail === undefined
    ? 0
    : visiblePlatforms.filter((platform) => detail.publish[platform.key].status === "published").length;
  const anyPublishMarked = detail !== undefined
    && visiblePlatforms.some((platform) => detail.publish[platform.key].status !== "unpublished");
  const publishStepDone = visiblePlatforms.length > 0 && publishedCount === visiblePlatforms.length;
  const stageIndex = detail === undefined ? 0 : WORKFLOW_INDEX[detail.workflow];
  const currentStep: PipelineStepId = publishStepDone
    ? "publish"
    : (PIPELINE_STEPS[stageIndex]?.id ?? "topic");

  const onReadyToRecord = (): void => {
    if (detail === undefined) return;
    void markReadyToRecord(detail.id).then((next) => { setDetail(next); });
  };

  const onBindStudio = (): void => {
    if (detail === undefined) return;
    void pickDirectory().then((path) => {
      if (path === null) return;
      return bindStudio(detail.id, path);
    }).then((next) => {
      if (next !== undefined) setDetail(next);
    });
  };

  const onOpenStudio = (): void => {
    if (detail === undefined) return;
    void openStudio(detail.id);
  };

  const onGenerateCover = (): void => {
    if (detail === undefined) return;
    if (detail.videoRaw === undefined && detail.videoSubtitled === undefined) {
      setActionError(t("inspector.cover.needVideo" as CreatorKey));
      return;
    }
    if (!detail.secrets.cover.configured) {
      setActionError(t("inspector.cover.needKey" as CreatorKey));
      return;
    }
    setActionError(undefined);
    setBusy("cover");
    void startCoverGenerate(detail.id).then((next) => {
      setDetail(next);
      setBusy(undefined);
    }, (cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
      setBusy(undefined);
    });
  };

  const onGenerateSubtitle = (): void => {
    if (detail === undefined) return;
    if (detail.videoRaw === undefined && detail.videoSubtitled === undefined) {
      setActionError(t("inspector.subtitle.needVideo" as CreatorKey));
      return;
    }
    if (!detail.secrets.subtitle.configured) {
      setActionError(t("inspector.subtitle.needKey" as CreatorKey));
      return;
    }
    setActionError(undefined);
    setBusy("subtitle");
    expectSubtitlePreview.current = true;
    void startSubtitleGenerate(detail.id).then((next) => {
      setDetail(next);
      setBusy(undefined);
    }, (cause: unknown) => {
      expectSubtitlePreview.current = false;
      setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
      setBusy(undefined);
    });
  };

  const onBurnSubtitle = (): void => {
    if (detail === undefined) return;
    if (detail.videoRaw === undefined) {
      setActionError(t("inspector.subtitle.needVideo" as CreatorKey));
      return;
    }
    if (!hasSubtitleDraft && detail.subtitleJob.status !== "done") {
      setActionError(t("inspector.subtitle.needDraft" as CreatorKey));
      return;
    }
    setActionError(undefined);
    setBusy("burn");
    void startSubtitleBurn(detail.id).then((next) => {
      setDetail(next);
      setBusy(undefined);
    }, (cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
      setBusy(undefined);
    });
  };

  const onPreviewSubtitle = (): void => {
    if (detail === undefined) return;
    void openSubtitlePreview(detail.id).then(() => undefined, (cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
    });
  };

  const onSyncPublish = (): void => {
    if (detail === undefined) return;
    setActionError(undefined);
    setBusy("sync");
    void syncPublish({ id: detail.id }).then((result) => {
      const login = result.platforms
        .filter((page) => page.loginRequired === true)
        .map((page) => {
          const label = PUBLISH_UI_PLATFORMS.find((item) => item.key === page.platform);
          return label === undefined ? page.platform : t(label.label);
        });
      setSyncHint(t((result.cached === true ? "inspector.publish.cached" : "inspector.publish.synced") as CreatorKey)
        .replace("{n}", String(result.matched)));
      if (login.length > 0) {
        setActionError(
          t("inspector.publish.login" as CreatorKey).replace("{name}", login.join("、")),
        );
      }
      setBusy(undefined);
      return getContent(detail.id);
    }).then((next) => {
      if (next !== undefined) setDetail(next);
    }, (cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : t("empty.error" as CreatorKey));
      setBusy(undefined);
    });
  };

  const subtitleStatus = (): { status: string; tone?: StatusTone } => {
    if (detail === undefined) return { status: "" };
    if (detail.subtitleJob.status === "running" || busy === "subtitle") {
      return { status: t("inspector.subtitle.generating" as CreatorKey), tone: "active" };
    }
    if (detail.burn.status === "running" || busy === "burn") {
      return { status: t("inspector.subtitle.burning" as CreatorKey), tone: "active" };
    }
    if (detail.subtitleJob.status === "error" || detail.burn.status === "error") {
      const raw = detail.subtitleJob.error ?? detail.burn.error;
      return {
        status: raw !== undefined && raw.includes("process exited")
          ? t("inspector.subtitle.failed" as CreatorKey)
          : raw ?? t("inspector.subtitle.failed" as CreatorKey),
        tone: "error",
      };
    }
    if (detail.videoSubtitled !== undefined) {
      return { status: t("inspector.subtitle.burned" as CreatorKey), tone: "success" };
    }
    if (hasSubtitleDraft) {
      return { status: t("inspector.subtitle.proofPending" as CreatorKey), tone: "pending" };
    }
    return { status: t("inspector.track.notGenerated" as CreatorKey) };
  };

  const coverStatus = (): { status: string; tone?: StatusTone } => {
    if (detail === undefined) return { status: "" };
    if (detail.coverJob.status === "running" || busy === "cover") {
      return { status: t("inspector.cover.generating" as CreatorKey), tone: "active" };
    }
    if (detail.coverJob.status === "error") {
      return {
        status: detail.coverJob.error ?? t("inspector.cover.failed" as CreatorKey),
        tone: "error",
      };
    }
    if (hasAnyCover) return { status: t("inspector.cover.ready" as CreatorKey), tone: "success" };
    return { status: t("inspector.track.notGenerated" as CreatorKey) };
  };

  const currentStepMeta = PIPELINE_STEPS.find((step) => step.id === currentStep);

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let target = index;
    if (event.key === "ArrowRight") target = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") target = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = TABS.length - 1;
    else return;
    event.preventDefault();
    const next = TABS[target];
    if (next === undefined) return;
    setTab(next);
    tabRefs.current[target]?.focus();
  };

  return (
    <div
      ref={pane}
      data-plugin="dsh-oil-creator"
      data-surface="inspector"
      className={wide ? "wide" : undefined}
    >
      <header className="header">
        <div className="titleRow">
          <div className="title">
            {detail?.title ?? (error === undefined ? t("empty.loading" as CreatorKey) : "")}
          </div>
          <div className="titleActions">
            {detail !== undefined && (
              <button
                type="button"
                className="close"
                aria-label={t("inspector.openFolder" as CreatorKey)}
                onClick={() => { void openPath(detail.folderPath); }}
              >
                <IconFolderOpenOutlineRegular size={14} />
              </button>
            )}
            <button
              data-detail-focus="true"
              type="button"
              className="close"
              aria-label={t("inspector.close" as CreatorKey)}
              onClick={() => {
                setSelectedId(null);
              }}
            >
              <IconCloseOutlineRegular size={14} />
            </button>
          </div>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((id, index) => (
            <button
              key={id}
              ref={(node) => { tabRefs.current[index] = node; }}
              id={`${tabGroupId}-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`${tabGroupId}-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? "tab active" : "tab"}
              onClick={() => { setTab(id); }}
              onKeyDown={(event) => { moveTabFocus(event, index); }}
            >
              {t(TAB_KEY[id])}
            </button>
          ))}
        </div>
      </header>
      <div
        id={`${tabGroupId}-panel-${tab}`}
        className="body"
        role="tabpanel"
        aria-labelledby={`${tabGroupId}-tab-${tab}`}
      >
        {error !== undefined && <div className="empty">{error}</div>}
        {error === undefined && detail === undefined && (
          <div className="empty">{t("empty.loading" as CreatorKey)}</div>
        )}
        {detail !== undefined && tab === "overview" && (
          <>
            <div className="lede">
              <div className="coverPair">
                <div className="coverHero">
                  <CoverThumb
                    id={detail.id}
                    load={getCoverThumb}
                    revision={coverThumbRevision(detail.covers)}
                    fallback={<IconBrowseOutlineRegular className="coverFallback" size={22} />}
                  />
                </div>
                {detail.covers["4x3"] !== undefined && (
                  <div className="coverWide">
                    <CoverThumb
                      id={`${detail.id}::4x3`}
                      load={getCoverThumb}
                      revision={detail.covers["4x3"]}
                      fallback={<IconBrowseOutlineRegular className="coverFallback" size={22} />}
                    />
                  </div>
                )}
              </div>
              <div className="ledeText">
                <StatusPill tone={WORKFLOW_TONE[detail.workflow]}>
                  {t(STAGE_KEY[detail.workflow])}
                </StatusPill>
                <div className="time">{formatRelativeTime(detail.recordedAt, Date.now(), t)}</div>
              </div>
            </div>
            <div className="stepper" aria-hidden="true">
              {PIPELINE_STEPS.map((step, index) => {
                const done = index < stageIndex || (step.id === "publish" && publishStepDone);
                const current = !done && step.id === currentStep;
                return (
                  <div
                    key={step.id}
                    className={`step ${done ? "done" : current ? "current" : ""}`}
                  >
                    <span className="stepDot" />
                    <span className="stepLabel">{t(step.label as CreatorKey)}</span>
                  </div>
                );
              })}
            </div>
            {hasVideo && (
              <Surface title={t("inspector.make" as CreatorKey)}>
                <div className="workList">
                  <WorkRow
                    name={t("inspector.track.subtitle" as CreatorKey)}
                    {...subtitleStatus()}
                  />
                  <WorkRow
                    name={t("inspector.track.cover" as CreatorKey)}
                    {...coverStatus()}
                    actions={(
                      <ActionButton
                        tone={hasAnyCover ? "secondary" : "primary"}
                        onClick={onGenerateCover}
                        disabled={busy !== undefined || detail.coverJob.status === "running"}
                      >
                        {t((hasAnyCover ? "inspector.cover.regenerate" : "inspector.cover.generate") as CreatorKey)}
                      </ActionButton>
                    )}
                  />
                </div>
              </Surface>
            )}
            {currentStepMeta !== undefined && currentStep !== "publish" && currentStep !== "finish" && (
              <Surface
                title={t(currentStepMeta.label as CreatorKey)}
                hint={"hint" in currentStepMeta ? t(currentStepMeta.hint as CreatorKey) : undefined}
              >
                {currentStep === "topic" && (
                  <ActionBar>
                    <ActionButton tone="primary" onClick={onReadyToRecord}>
                      {t("inspector.readyToRecord" as CreatorKey)}
                    </ActionButton>
                  </ActionBar>
                )}
                {currentStep === "record" && (
                  <ActionBar>
                    <ActionButton
                      tone="primary"
                      onClick={detail.studioPath === undefined ? onBindStudio : onOpenStudio}
                    >
                      {t((detail.studioPath === undefined ? "inspector.studio.bind" : "inspector.studio.open") as CreatorKey)}
                    </ActionButton>
                  </ActionBar>
                )}
                {currentStep === "cut" && (
                  <>
                    {detail.waitingForExport && !hasVideo && (
                      <JobNote tone={detail.exportTimedOut === true ? "error" : "running"}>
                        {t((detail.exportTimedOut === true
                          ? "inspector.step.exportTimedOut"
                          : "inspector.step.waitingExport") as CreatorKey)}
                      </JobNote>
                    )}
                    <ActionBar>
                      <ActionButton
                        tone="primary"
                        onClick={detail.studioPath === undefined ? onBindStudio : onOpenStudio}
                      >
                        {t((detail.studioPath === undefined ? "inspector.studio.bind" : "inspector.studio.open") as CreatorKey)}
                      </ActionButton>
                      {detail.studioPath !== undefined && (
                        <ActionButton onClick={onBindStudio}>
                          {t("inspector.studio.rebind" as CreatorKey)}
                        </ActionButton>
                      )}
                    </ActionBar>
                  </>
                )}
              </Surface>
            )}
            {actionError !== undefined && (
              <JobNote tone="error">{actionError}</JobNote>
            )}
            {(detail.workflow === "publish" || anyPublishMarked || detail.hasArticle) && (
              <>
                <Surface
                  title={t("inspector.sync.title" as CreatorKey)}
                  hint={syncHint ?? t((platformSettingsPending
                    ? "inspector.publish.platformsLoading"
                    : "inspector.sync.hint") as CreatorKey)}
                >
                  {!platformSettingsPending && visiblePlatforms.length === 0 && (
                    <div className="empty">{t("inspector.publish.enablePlatforms" as CreatorKey)}</div>
                  )}
                  <ActionBar>
                    <ActionButton
                      tone="primary"
                      onClick={onSyncPublish}
                      disabled={isPublishSyncDisabled(busy, platformSettingsPending, enabledPlatforms ?? [])}
                    >
                      {t((busy === "sync" ? "inspector.publish.syncing" : "inspector.publish.sync") as CreatorKey)}
                    </ActionButton>
                  </ActionBar>
                </Surface>
                {visiblePlatforms.length > 0 && (
                  <Surface title={t("inspector.platforms" as CreatorKey)}>
                    <div className="publishGrid">
                      {visiblePlatforms.map((platform) => {
                        const row = detail.publish[platform.key];
                        const metrics = metricParts(row, t);
                        return (
                          <div key={platform.id} className="publishCard">
                            <div className="publishRow">
                              <span className="publishName">
                                <PlatformMark id={platform.id} size={16} />
                                {t(platform.label)}
                              </span>
                              <Menu
                                portal={true}
                                align="end"
                                open={publishMenu === platform.key}
                                anchor={(
                                  <StatusPill
                                    tone={PUBLISH_TONE[row.status]}
                                    disabled={publishPending === platform.key}
                                    aria-haspopup="menu"
                                    aria-label={`${t(platform.label)}：${t(PUBLISH_KEY[row.status])}`}
                                    onClick={() => {
                                      setPublishMenu(publishMenu === platform.key ? null : platform.key);
                                    }}
                                  >
                                    {t(PUBLISH_KEY[row.status])}
                                  </StatusPill>
                                )}
                                items={PUBLISH_MARKS.map((mark) => ({ id: mark, label: t(PUBLISH_KEY[mark]) }))}
                                selectedId={row.status}
                                onSelect={(id) => {
                                  if (isPublishMark(id)) applyPublish(platform.key, id);
                                }}
                                onClose={() => { setPublishMenu(null); }}
                              />
                            </div>
                            {metrics.length > 0 && (
                              <div className="publishMetrics">{metrics.join(" · ")}</div>
                            )}
                            {row.status === "published" && row.url !== undefined && (
                              <a className="publishUrl" href={row.url} target="_blank" rel="noreferrer">
                                {t("inspector.publish.open" as CreatorKey)}
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </Surface>
                )}
                <Surface title={t("inspector.article" as CreatorKey)}>
                  <button
                    type="button"
                    className="publishRow articleRow"
                    onClick={() => { setTab("article"); }}
                  >
                    <span className="publishName">
                      <PlatformMark id="article" size={16} />
                      {t("inspector.article.draft" as CreatorKey)}
                    </span>
                    <StatusPill tone={detail.hasArticle ? "success" : "neutral"}>
                      {t((detail.hasArticle ? "inspector.article.ready" : "inspector.article.missing") as CreatorKey)}
                    </StatusPill>
                  </button>
                </Surface>
              </>
            )}
            {detail.tags.length > 0 && (
              <Surface title={t("detail.tags" as CreatorKey)}>
                <div className="tags">
                  {detail.tags.map((tag) => (
                    <span key={tag} className="tag">#{tag}</span>
                  ))}
                </div>
              </Surface>
            )}
          </>
        )}
        {detail !== undefined && tab === "video" && (
          !videoReady
            ? <div className="empty">{t("empty.loading" as CreatorKey)}</div>
            : videoSrc === undefined
              ? <div className="empty">{t("inspector.video.empty" as CreatorKey)}</div>
              : (
                <video
                  className="videoPlayer"
                  controls={true}
                  playsInline={true}
                  preload="metadata"
                  src={videoSrc}
                />
              )
        )}
        {detail !== undefined && tab === "script" && (
          <textarea
            className="scriptEditor"
            value={scriptDraft}
            placeholder={t("inspector.script.placeholder" as CreatorKey)}
            onChange={(event) => {
              pendingScriptDrafts.set(detail.folderPath, event.target.value);
              setScriptDraft(event.target.value);
              setScriptSaved(event.target.value === detail.script);
            }}
          />
        )}
        {detail !== undefined && tab === "article" && (
          detail.article.trim() === ""
            ? <div className="empty">{t("inspector.article.empty" as CreatorKey)}</div>
            : (
              <div className="article">
                <MarkdownText
                  labels={{ code: { copyLabel: t("markdown.copy"), copiedLabel: t("markdown.copied") }, footnotes: t("markdown.footnotes") }}
                  text={articleOrigin === undefined
                    ? detail.article
                    : rewriteArticleImages(detail.article, articleOrigin)}
                />
              </div>
            )
        )}
        {detail !== undefined && tab === "subtitle" && (
          <>
            {hasVideo && (
              <ActionBar>
                {canPreviewSubtitle && (
                  <ActionButton tone="ghost" onClick={onPreviewSubtitle}>
                    {t("inspector.subtitle.previewEdit" as CreatorKey)}
                  </ActionButton>
                )}
                <ActionButton
                  tone={!hasSubtitleDraft && detail.videoSubtitled === undefined ? "primary" : "secondary"}
                  onClick={onGenerateSubtitle}
                  disabled={
                    busy !== undefined
                    || detail.subtitleJob.status === "running"
                    || detail.burn.status === "running"
                  }
                >
                  {t((
                    !hasSubtitleDraft
                      ? "inspector.subtitle.generate"
                      : "inspector.subtitle.regenerate"
                  ) as CreatorKey)}
                </ActionButton>
                {hasSubtitleDraft && (
                  <ActionButton
                    tone={detail.videoSubtitled === undefined ? "primary" : "secondary"}
                    onClick={onBurnSubtitle}
                    disabled={
                      busy !== undefined
                      || detail.subtitleJob.status === "running"
                      || detail.burn.status === "running"
                    }
                  >
                    {t((detail.videoSubtitled === undefined
                      ? "inspector.subtitle.burn"
                      : "inspector.subtitle.reburn") as CreatorKey)}
                  </ActionButton>
                )}
              </ActionBar>
            )}
            {actionError !== undefined
              ? <JobNote tone="error">{actionError}</JobNote>
              : detail.subtitleJob.status === "running" || detail.burn.status === "running"
                ? (
                  <JobNote tone="running">
                    {t((detail.subtitleJob.status === "running"
                      ? "inspector.subtitle.generating"
                      : "inspector.subtitle.burning") as CreatorKey)}
                  </JobNote>
                )
                : detail.subtitleJob.status === "error" || detail.burn.status === "error"
                  ? (
                    <JobNote tone="error">
                      {(detail.subtitleJob.error ?? detail.burn.error ?? "").includes("process exited")
                        ? t("inspector.subtitle.burnFailed" as CreatorKey)
                        : detail.subtitleJob.error
                          ?? detail.burn.error
                          ?? t("inspector.subtitle.burnFailed" as CreatorKey)}
                    </JobNote>
                  )
                  : null}
            {cues.length === 0
              ? <div className="empty">{t("inspector.subtitle.empty" as CreatorKey)}</div>
              : (
                <ol className="cues">
                  {cues.map((cue, index) => (
                    <li key={`${cue.at ?? "cue"}-${index}`} className="cue">
                      {cue.at !== undefined && <div className="cueTime">{cue.at}</div>}
                      <p className="cueText">{cue.text}</p>
                    </li>
                  ))}
                </ol>
              )}
          </>
        )}
      </div>
    </div>
  );
}
