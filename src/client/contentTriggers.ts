import { formatContentRef } from "../contentRef.ts";
import type { ContentDetail } from "../types.ts";
import { getSelectedContentId, subscribeSelectedContentId } from "./contentSelection.ts";

interface TriggerCandidate {
  name: string;
  description?: string;
}

interface TriggerPick {
  candidate: TriggerCandidate;
  session?: unknown;
}

type PickOutcome = { insert: {
  source: string;
  ref: string;
  label: string;
  clipboardText: string;
} } | { text: string } | undefined;

interface TriggerSource {
  trigger: "@" | "/";
  name: string;
  order?: number;
  candidates: (
    session: unknown,
    req: { query: string; signal: AbortSignal },
  ) => Promise<readonly TriggerCandidate[]>;
  onPick: (pick: TriggerPick) => PickOutcome;
  lexicon?: (session?: unknown) => readonly string[] | undefined;
  subscribeLexicon?: (_session: unknown, listener: () => void) => () => void;
  codec?: {
    clipboardText: (ref: string) => string;
    serialize: (ref: string, signal: AbortSignal) => Promise<string>;
  };
}

interface TriggerService {
  registerSource: (src: TriggerSource) => () => void;
}

/** Composer chips occupy a fixed 4em cell; longer labels are centered and clipped. */
const CHIP_UNITS = 8;

function charUnits(ch: string): number {
  return /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
}

export function chipLabel(title: string): string {
  const chars = [...title.trim()];
  if (chars.length === 0) return "内容";
  let used = 0;
  const out: string[] = [];
  for (const ch of chars) {
    const w = charUnits(ch);
    if (used + w > CHIP_UNITS) {
      while (used > CHIP_UNITS - 1 && out.length > 0) {
        used -= charUnits(out[out.length - 1] ?? "");
        out.pop();
      }
      while (out.length > 0 && out[out.length - 1] === " ") {
        used -= 1;
        out.pop();
      }
      out.push("…");
      return out.join("");
    }
    out.push(ch);
    used += w;
  }
  return out.join("");
}

export function registerContentTriggers(
  inputTriggers: TriggerService | undefined,
  load: (id: string) => Promise<ContentDetail>,
  list: () => Promise<ReadonlyArray<{ id: string; title: string }>>,
  ownsCurrentSession: (session?: unknown) => boolean = () => true,
): () => void {
  if (inputTriggers === undefined) return () => undefined;

  const serialize = async (ref: string, signal: AbortSignal): Promise<string> => {
    if (!ownsCurrentSession()) throw new Error("请先在内容工作台打开所属会话。");
    const id = ref === "current" ? getSelectedContentId() : ref;
    if (id === null || id === "") return "当前没有打开的内容。用 @ 选一条，或先在内容页打开详情。";
    signal.throwIfAborted();
    const detail = await load(id);
    signal.throwIfAborted();
    if (!ownsCurrentSession()) throw new Error("会话已切换，请重新选择内容。");
    return formatContentRef(detail);
  };

  const insert = (ref: string, title: string): PickOutcome => ({
    insert: {
      source: "oil",
      ref,
      label: chipLabel(title),
      clipboardText: `@${title}`,
    },
  });

  const atSource: TriggerSource = {
    trigger: "@",
    name: "oil",
    order: 30,
    async candidates(session, req) {
      if (!ownsCurrentSession(session) || req.signal.aborted) return [];
      const query = req.query.trim().toLowerCase();
      const items = await list();
      if (!ownsCurrentSession(session) || req.signal.aborted) return [];
      const rows: TriggerCandidate[] = [];
      const selected = getSelectedContentId();
      if (selected !== null && ("当前".includes(query) || query === "")) {
        const current = items.find((item) => item.id === selected);
        rows.push({
          name: "当前详情",
          description: current?.title ?? selected,
        });
      }
      for (const item of items) {
        if (query !== "" && !item.title.toLowerCase().includes(query) && !item.id.toLowerCase().includes(query)) {
          continue;
        }
        rows.push({ name: item.title, description: item.id });
      }
      return rows.slice(0, 20);
    },
    onPick({ candidate, session }) {
      if (!ownsCurrentSession(session)) return undefined;
      if (candidate.name === "当前详情") return insert("current", "当前详情");
      return insert(candidate.description ?? candidate.name, candidate.name);
    },
    lexicon(session) {
      return ownsCurrentSession(session) ? ["当前详情"] : [];
    },
    subscribeLexicon(_session, listener) {
      return subscribeSelectedContentId(listener);
    },
    codec: {
      clipboardText: (ref) => (ref === "current" ? "@当前详情" : `@${ref}`),
      serialize,
    },
  };

  const slashSource: TriggerSource = {
    trigger: "/",
    name: "oil",
    order: 40,
    async candidates(session, req) {
      if (!ownsCurrentSession(session) || req.signal.aborted) return [];
      const query = req.query.trim().toLowerCase();
      const name = "current content";
      if (query !== "" && !name.includes(query) && !"当前内容".includes(query)) {
        return [];
      }
      return [{ name, description: "把当前打开的内容交给对话" }];
    },
    onPick({ session }) {
      if (!ownsCurrentSession(session)) return undefined;
      return insert("current", "当前内容");
    },
    lexicon(session) {
      return ownsCurrentSession(session) ? ["current content", "当前内容"] : [];
    },
    codec: {
      clipboardText: () => "/current content",
      serialize,
    },
  };

  const stopAt = inputTriggers.registerSource(atSource);
  const stopSlash = inputTriggers.registerSource(slashSource);
  return () => {
    stopAt();
    stopSlash();
  };
}
