// Ego Lite script. Run: ego-browser nodejs < scripts/collect-publish.mjs
// Optional: OIL_COLLECT_PLATFORMS, OIL_COLLECT_TARGETS, OIL_COLLECT_SPACE,
// OIL_COLLECT_KEEP, OIL_COLLECT_CLEANUP_STALE, OIL_COLLECT_CLEANUP_NAMES,
// OIL_COLLECT_CLEANUP_PREFIXES, OIL_COLLECT_MAX_PAGES, OIL_COLLECT_XHS_SCROLL.
// Each run uses a new oil-collect-* space and closes it when finished.
const PAGES = [
  { platform: "xiaohongshu", url: "https://creator.xiaohongshu.com/new/note-manager" },
  { platform: "douyin", url: "https://creator.douyin.com/creator-micro/content/manage" },
  { platform: "bilibili", url: "https://member.bilibili.com/platform/upload-manager/article" },
  { platform: "wechat", url: "https://channels.weixin.qq.com/platform/post/list" },
];

function envText(name, fallback) {
  if (typeof globalThis[name] === "string" && globalThis[name] !== "") return globalThis[name];
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

const MAX_PAGES = Math.max(1, Number(envText("OIL_COLLECT_MAX_PAGES", "80")) || 80);
const XHS_SCROLL_STEPS = Math.max(1, Number(envText("OIL_COLLECT_XHS_SCROLL", "80")) || 80);

const wanted = String(
  typeof OIL_COLLECT_PLATFORMS === "string" ? OIL_COLLECT_PLATFORMS : (process.env.OIL_COLLECT_PLATFORMS ?? ""),
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const pages = wanted.length === 0 ? PAGES : PAGES.filter((page) => wanted.includes(page.platform));

function parseTargets(raw) {
  if (Array.isArray(raw)) return raw.filter((item) => item && typeof item.title === "string");
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.title === "string") : [];
  } catch {
    return [];
  }
}

const targets = parseTargets(
  typeof OIL_COLLECT_TARGETS !== "undefined" ? OIL_COLLECT_TARGETS : process.env.OIL_COLLECT_TARGETS,
);

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function titleScore(local, remote) {
  const left = normalizeTitle(local);
  const right = normalizeTitle(remote);
  if (left === "" || right === "") return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.88;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let hits = 0;
  const size = Math.min(4, shorter.length);
  if (size < 2) return 0;
  for (let index = 0; index <= shorter.length - size; index += 1) {
    if (longer.includes(shorter.slice(index, index + size))) hits += 1;
  }
  const possible = shorter.length - size + 1;
  return possible === 0 ? 0 : hits / possible * 0.7;
}

function hitsTarget(item) {
  if (targets.length === 0) return false;
  return targets.some((target) => {
    const remoteIds = Array.isArray(target.remoteIds) ? target.remoteIds : [];
    const urls = Array.isArray(target.urls) ? target.urls : [];
    if (item.remoteId && remoteIds.includes(item.remoteId)) return true;
    if (item.url && urls.includes(item.url)) return true;
    return titleScore(target.title, item.title) >= 0.85;
  });
}

function foundTargets(items) {
  return targets.length > 0 && (items || []).some(hitsTarget);
}

const HOOK = `(() => {
  if (window.__oilCollectHook) return;
  window.__oilCollectHook = true;
  window.__OIL_COLLECT__ = [];
  const push = (url, text) => {
    window.__OIL_COLLECT__.push({ url: String(url), text: String(text || "").slice(0, 900000) });
  };
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === "string" ? req : (req && req.url) || "";
      push(url, await res.clone().text());
    } catch {}
    return res;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__oilUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try { push(this.__oilUrl, this.responseText); } catch {}
    });
    return origSend.apply(this, args);
  };
})()`;

function firstLine(value) {
  return String(value || "").split(/\n/)[0].trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.remoteId || item.url || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function parseDouyinPayload(payload) {
  const list = payload?.aweme_list;
  if (!Array.isArray(list)) return [];
  return list.flatMap((aweme) => {
    const title = firstLine(aweme.item_title || aweme.desc || "");
    if (!title) return [];
    const id = aweme.aweme_id ? String(aweme.aweme_id) : "";
    const stats = aweme.statistics || {};
    const item = { title };
    if (id) item.remoteId = id;
    if (typeof aweme.share_url === "string" && aweme.share_url.startsWith("http")) item.url = aweme.share_url;
    else if (id) item.url = `https://www.douyin.com/video/${id}`;
    const views = num(stats.play_count);
    const likes = num(stats.digg_count);
    const comments = num(stats.comment_count);
    if (views !== undefined) item.views = views;
    if (likes !== undefined) item.likes = likes;
    if (comments !== undefined) item.comments = comments;
    return [item];
  });
}

function parseBiliPayload(payload) {
  const list = payload?.data?.arc_audits;
  if (!Array.isArray(list)) return [];
  return list.flatMap((row) => {
    const arc = row.Archive || {};
    const title = firstLine(arc.title);
    if (!title) return [];
    const bvid = arc.bvid ? String(arc.bvid) : "";
    const stat = row.stat || {};
    const item = { title };
    if (bvid) {
      item.remoteId = bvid;
      item.url = `https://www.bilibili.com/video/${bvid}`;
    }
    if (Number.isFinite(Number(stat.view))) item.views = Number(stat.view);
    if (Number.isFinite(Number(stat.like))) item.likes = Number(stat.like);
    if (Number.isFinite(Number(stat.reply))) item.comments = Number(stat.reply);
    return [item];
  });
}

function parseWechatPayload(payload) {
  const list = payload?.data?.list;
  if (!Array.isArray(list)) return [];
  return list.flatMap((row) => {
    const title = firstLine(row?.desc?.description) || "未填写标题";
    const id = row.objectId ? String(row.objectId) : "";
    const item = { title };
    if (id) {
      item.remoteId = id;
      item.url = "https://channels.weixin.qq.com/platform/post/list";
    }
    if (Number.isFinite(Number(row.readCount))) item.views = Number(row.readCount);
    if (Number.isFinite(Number(row.likeCount))) item.likes = Number(row.likeCount);
    if (Number.isFinite(Number(row.commentCount))) item.comments = Number(row.commentCount);
    return [item];
  });
}

async function pageJson(expression) {
  const answer = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (answer?.exceptionDetails) {
    const detail = answer.exceptionDetails.exception?.description || answer.exceptionDetails.text;
    throw new Error(detail || "evaluate failed");
  }
  return answer?.result?.value;
}

async function activateWechat() {
  await cdp("Page.bringToFront", {});
  await cdp("Page.setWebLifecycleState", { state: "active" });
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
}

async function hookTab() {
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await js(HOOK);
}

function pageLooksLoggedOut(text, href) {
  const body = String(text || "");
  const login = /登录|掃碼|扫码登录|请先登录|尚未登录/.test(body)
    && !/作品管理|笔记管理|已发布|稿件管理|发表记录|视频管理|内容管理/.test(body);
  return login || /login\.html/.test(String(href || ""));
}

async function xhsState() {
  return js(String.raw`(() => {
    const rows = window.__OIL_COLLECT__ || [];
    const byId = new Map();
    let total = 0;
    for (const row of rows) {
      if (!String(row.url).includes("/creator/note/user/posted")) continue;
      let json;
      try { json = JSON.parse(row.text); } catch { continue; }
      const notes = json && json.data && json.data.notes;
      if (Array.isArray(notes)) {
        for (const note of notes) {
          const title = String(note.display_title || note.title || "").split(/\n/)[0].trim();
          if (!title) continue;
          const id = note.id ? String(note.id) : title;
          const token = note.xsec_token ? String(note.xsec_token) : "";
          const item = { title };
          if (note.id) {
            item.remoteId = String(note.id);
            item.url = token
              ? "https://www.xiaohongshu.com/explore/" + note.id + "?xsec_token=" + encodeURIComponent(token)
              : "https://www.xiaohongshu.com/explore/" + note.id;
          }
          const views = Number(note.view_count);
          const likes = Number(note.likes);
          const comments = Number(note.comments_count);
          if (Number.isFinite(views)) item.views = views;
          if (Number.isFinite(likes)) item.likes = likes;
          if (Number.isFinite(comments)) item.comments = comments;
          byId.set(id, item);
        }
      }
      const tags = json && json.data && json.data.tags;
      const checked = Array.isArray(tags) ? tags.find((tag) => tag && tag.checked) : undefined;
      if (checked && Number.isFinite(Number(checked.notes_count))) total = Number(checked.notes_count);
    }
    const text = (document.body && document.body.innerText) || "";
    const login = /登录|掃碼|扫码登录|请先登录|尚未登录/.test(text)
      && !/作品管理|笔记管理|已发布|稿件管理|发表记录|视频管理|内容管理/.test(text);
    return {
      items: [...byId.values()],
      n: byId.size,
      total,
      loginRequired: byId.size === 0 && login,
      loading: /正在加载中/.test(text),
    };
  })()`);
}

async function scrollXhsList() {
  await js(String.raw`(() => {
    const el = [...document.querySelectorAll("*")].filter((node) => {
      const style = getComputedStyle(node);
      return (style.overflowY === "auto" || style.overflowY === "scroll")
        && node.scrollHeight > node.clientHeight + 80;
    }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (el) el.scrollTop = el.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
  })()`);
  try { await scroll({ dy: 1800 }); } catch { /* page may ignore wheel */ }
}

async function collectXiaohongshu(url) {
  await hookTab();
  let state = await xhsState();
  if (state.n === 0) {
    await gotoAndWait(url, { timeout: 40, settle: 2 });
    await hookTab();
    const started = Date.now();
    while (Date.now() - started < 12_000) {
      state = await xhsState();
      if (state.loginRequired || state.n > 0) break;
      await wait(1);
    }
  }
  if (state.loginRequired) return { items: [], loginRequired: true };

  let last = state.n;
  let stall = 0;
  for (let step = 0; step < XHS_SCROLL_STEPS; step += 1) {
    if (foundTargets(state.items)) break;
    if (state.total > 0 && state.n >= state.total && !state.loading) break;
    await scrollXhsList();
    await wait(1.1);
    state = await xhsState();
    if (state.n <= last) {
      stall += 1;
      if (stall >= 5 && !state.loading) break;
    } else {
      stall = 0;
      last = state.n;
    }
  }
  return { items: dedupe(state.items || []), loginRequired: false };
}

async function collectDouyin() {
  const items = [];
  let cursor = 0;
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await pageJson(`fetch("/janus/douyin/creator/pc/work_list?status=0&count=20&max_cursor=${cursor}&scene=star_atlas&device_platform=android&aid=1128", {
      credentials: "include"
    }).then(async (r) => ({ http: r.status, json: await r.json() }))`);
    const json = payload?.json;
    if (payload?.http && payload.http >= 400) break;
    const batch = parseDouyinPayload(json);
    items.push(...batch);
    if (foundTargets(items)) break;
    if (typeof json?.total === "number") total = json.total;
    const hasMore = json?.has_more === true || json?.has_more === 1;
    const next = Number(json?.max_cursor);
    if (batch.length === 0 || !hasMore || items.length >= total) break;
    if (!Number.isFinite(next) || next === cursor) break;
    cursor = next;
  }
  if (items.length > 0) return { items: dedupe(items), loginRequired: false };

  await hookTab();
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    const hooked = await js(String.raw`(() => {
      const rows = (window.__OIL_COLLECT__ || []).filter((row) => String(row.url).includes("/work_list"));
      const text = (document.body && document.body.innerText) || "";
      const login = /登录|掃碼|扫码登录|请先登录|尚未登录/.test(text)
        && !/作品管理|笔记管理|已发布|稿件管理|发表记录|视频管理|内容管理/.test(text);
      const byId = new Map();
      for (const row of rows) {
        let json;
        try { json = JSON.parse(row.text); } catch { continue; }
        const list = json && json.aweme_list;
        if (!Array.isArray(list)) continue;
        for (const aweme of list) {
          const title = String(aweme.item_title || aweme.desc || "").split(/\n/)[0].trim();
          if (!title) continue;
          const id = aweme.aweme_id ? String(aweme.aweme_id) : title;
          const stats = aweme.statistics || {};
          const item = { title };
          if (aweme.aweme_id) item.remoteId = String(aweme.aweme_id);
          if (typeof aweme.share_url === "string" && aweme.share_url.startsWith("http")) item.url = aweme.share_url;
          else if (aweme.aweme_id) item.url = "https://www.douyin.com/video/" + aweme.aweme_id;
          const views = Number(stats.play_count);
          const likes = Number(stats.digg_count);
          const comments = Number(stats.comment_count);
          if (Number.isFinite(views)) item.views = views;
          if (Number.isFinite(likes)) item.likes = likes;
          if (Number.isFinite(comments)) item.comments = comments;
          byId.set(id, item);
        }
      }
      return { items: [...byId.values()], loginRequired: byId.size === 0 && login };
    })()`);
    if (hooked?.loginRequired || (Array.isArray(hooked?.items) && hooked.items.length > 0)) return hooked;
    await wait(1);
  }
  return { items: [], loginRequired: false };
}

async function collectBilibili() {
  const items = [];
  let expected = Number.POSITIVE_INFINITY;
  for (let pn = 1; pn <= MAX_PAGES; pn += 1) {
    const payload = await pageJson(`fetch("/x/web/archives?status=pubed&pn=${pn}&ps=30&coop=1&interactive=1", {
      credentials: "include"
    }).then((r) => r.json())`);
    const batch = parseBiliPayload(payload);
    items.push(...batch);
    if (foundTargets(items)) break;
    const count = payload?.data?.page?.count ?? payload?.data?.class?.pubed;
    if (typeof count === "number") expected = count;
    if (batch.length === 0 || items.length >= expected) break;
  }
  return { items: dedupe(items), loginRequired: false };
}

async function collectWechat() {
  const items = [];
  let expected = Number.POSITIVE_INFINITY;
  for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage += 1) {
    const payload = await pageJson(`fetch("/cgi-bin/mmfinderassistant-bin/post/post_list", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPage: ${currentPage}, pageSize: 20 })
    }).then((r) => r.json())`);
    const batch = parseWechatPayload(payload);
    items.push(...batch);
    if (foundTargets(items)) break;
    if (typeof payload?.data?.totalCount === "number") expected = payload.data.totalCount;
    const cont = payload?.data?.continueFlag;
    if (batch.length === 0 || cont === false || items.length >= expected) break;
  }
  return { items: dedupe(items), loginRequired: false };
}

function csvNames(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const keepSpace = envText("OIL_COLLECT_KEEP", "0") === "1";
const cleanupStale = envText("OIL_COLLECT_CLEANUP_STALE", "1") !== "0";
const spaceName = envText("OIL_COLLECT_SPACE", "") || `oil-collect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const leftoverNames = new Set(["oil-collect-publish", ...csvNames(envText("OIL_COLLECT_CLEANUP_NAMES", ""))]);
const leftoverPrefixes = csvNames(envText("OIL_COLLECT_CLEANUP_PREFIXES", ""));
const task = await useOrCreateTaskSpace(spaceName);
const collected = [];
let spaceClosed = keepSpace;
try {
  for (const page of pages) {
    try {
      if (page.platform === "wechat") await activateWechat();
      await openOrReuseTab(page.url, { wait: true, timeout: 35 });
      if (page.platform === "wechat") await activateWechat();
      await hookTab();

      const text = await js(`(document.body && document.body.innerText) || ""`);
      const href = await js(`location.href`);
      if (pageLooksLoggedOut(text, href)) {
        collected.push({ platform: page.platform, items: [], loginRequired: true });
        continue;
      }

      let extracted = { items: [], loginRequired: false };
      if (page.platform === "xiaohongshu") extracted = await collectXiaohongshu(page.url);
      else if (page.platform === "douyin") extracted = await collectDouyin();
      else if (page.platform === "bilibili") extracted = await collectBilibili();
      else if (page.platform === "wechat") {
        await activateWechat();
        extracted = await collectWechat();
      }

      collected.push({
        platform: page.platform,
        items: Array.isArray(extracted?.items) ? extracted.items : [],
        loginRequired: extracted?.loginRequired === true,
      });
    } catch (cause) {
      collected.push({
        platform: page.platform,
        items: [],
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
} finally {
  if (!keepSpace) {
    try {
      await completeTaskSpace(task.id, { keep: false });
      spaceClosed = true;
    } catch {
      spaceClosed = false;
    }
  }
  if (cleanupStale && typeof listTaskSpaces === "function") {
    try {
      const spaces = await listTaskSpaces();
      for (const space of spaces || []) {
        const name = String(space.name || "");
        if (space.ownership === "user") continue;
        if (keepSpace && space.id === task.id) continue;
        const current = !spaceClosed && (space.id === task.id || name === spaceName || name === task.name);
        const named = leftoverNames.has(name);
        const prefixed = leftoverPrefixes.some((prefix) => name === prefix || name.startsWith(prefix));
        if (!current && !named && !prefixed) continue;
        try {
          await completeTaskSpace(space.id, { keep: false });
          if (space.id === task.id) spaceClosed = true;
        } catch { /* ignore stale close errors */ }
      }
    } catch { /* listing spaces is best-effort */ }
  }
}
cliLog(JSON.stringify({
  ok: true,
  taskId: task.id,
  taskSpace: task.name || spaceName,
  collected,
  spaceClosed,
}));
