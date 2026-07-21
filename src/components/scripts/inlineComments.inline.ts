import { computePosition, offset, flip, shift, autoUpdate } from "@floating-ui/dom";

// ────────────────────────────────────────────────────────────────────────
// Inline, anchored comments for Quartz, backed by GitHub Discussions.
//
//  • Anchoring uses a W3C-style text-quote + text-position selector so a
//    comment survives reflow and minor content edits.
//  • Reads go through the serverless worker (`apiBase`) so anonymous visitors
//    can see highlights without logging in.
//  • Writes go straight to GitHub's GraphQL API with the user's own token.
//
// See docs-internal/inline-comments-design.md for the full design.
// ────────────────────────────────────────────────────────────────────────

type TextQuoteAnchor = {
  v: number;
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  slug: string;
};

type CommentAuthor = { login: string; avatarUrl: string };

type RawComment = {
  id: string;
  author: CommentAuthor;
  body: string;
  bodyHTML: string;
  createdAt: string;
  url: string;
  replies?: RawComment[];
};

type CommentsResponse = {
  discussionId: string | null;
  discussionNumber: number | null;
  comments: RawComment[];
};

type Config = {
  repo: string;
  repoId: string;
  category: string;
  categoryId: string;
  apiBase: string;
  mapping: string;
  baseUrl: string;
};

type TextSegment = { node: Text; start: number; end: number };

const TOKEN_KEY = "inline-comments-gh-token";
const VIEWER_KEY = "inline-comments-gh-viewer";
const STATE_KEY = "inline-comments-oauth-state";
const ANCHOR_RE = /<!--\s*quartz-anchor:\s*(\{[\s\S]*?\})\s*-->/;
const CONTEXT_LEN = 32;
const GITHUB_GRAPHQL = "https://api.github.com/graphql";

// ─── config ─────────────────────────────────────────────────────────────

function readConfig(container: HTMLElement): Config {
  const d = container.dataset;
  return {
    repo: d.repo ?? "",
    repoId: d.repoId ?? "",
    category: d.category ?? "",
    categoryId: d.categoryId ?? "",
    apiBase: (d.apiBase ?? "").replace(/\/$/, ""),
    mapping: d.mapping ?? "pathname",
    baseUrl: d.baseUrl ?? "",
  };
}

function getRoot(): HTMLElement | null {
  return document.querySelector("article.popover-hint");
}

function getTerm(cfg: Config): string {
  switch (cfg.mapping) {
    case "title":
      return document.title;
    case "url":
      return location.origin + location.pathname;
    case "pathname":
    default:
      return location.pathname.replace(/\/+$/, "") || "/";
  }
}

// ─── anchoring engine ───────────────────────────────────────────────────

// Collect the article's text nodes with their cumulative character offsets,
// skipping our own injected UI (badges) so offsets stay stable across renders.
function collectSegments(root: Node): { text: string; segments: TextSegment[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = (node as Text).parentElement;
      if (parent?.closest("[data-inline-comment-ignore]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const segments: TextSegment[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const start = text.length;
    text += t.data;
    segments.push({ node: t, start, end: text.length });
  }
  return { text, segments };
}

// Character offset within the concatenated article text for a DOM boundary
// point. Works for both text-node and element containers.
function pointOffset(
  segments: TextSegment[],
  container: Node,
  offsetInNode: number,
): number | null {
  const probe = document.createRange();
  try {
    probe.setStart(container, offsetInNode);
    probe.collapse(true);
  } catch {
    return null;
  }
  let total = 0;
  for (const seg of segments) {
    let endCmp: number;
    let startCmp: number;
    try {
      endCmp = probe.comparePoint(seg.node, seg.node.data.length);
      startCmp = probe.comparePoint(seg.node, 0);
    } catch {
      continue;
    }
    if (endCmp <= 0) {
      // whole segment lies before the boundary
      total += seg.node.data.length;
    } else if (startCmp >= 0) {
      // whole segment lies after the boundary — nothing to add
    } else {
      // boundary falls inside this segment
      if (container === seg.node) {
        total += offsetInNode;
      } else {
        total += seg.node.data.length;
      }
    }
  }
  return total;
}

function nearestHeadingSlug(node: Node): string {
  let el: Element | null =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el) {
    const heading = el.matches?.("h1,h2,h3,h4,h5,h6")
      ? el
      : el.previousElementSibling?.closest?.("h1,h2,h3,h4,h5,h6");
    if (heading?.id) return heading.id;
    el = el.parentElement;
  }
  const firstHeadingWithId = document.querySelector(
    "article.popover-hint :is(h1,h2,h3,h4,h5,h6)[id]",
  );
  return firstHeadingWithId?.id ?? "";
}

function anchorFromRange(root: HTMLElement, range: Range): TextQuoteAnchor | null {
  const { text, segments } = collectSegments(root);
  const start = pointOffset(segments, range.startContainer, range.startOffset);
  const end = pointOffset(segments, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  const exact = text.slice(start, end);
  if (!exact.trim()) return null;
  return {
    v: 1,
    exact,
    prefix: text.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_LEN)),
    start,
    end,
    slug: nearestHeadingSlug(range.startContainer),
  };
}

// Locate the anchor's text in the current article, disambiguating repeated
// matches by surrounding context and stored position. Returns null (→ orphan)
// if the exact text is no longer present.
function resolveAnchor(
  text: string,
  anchor: TextQuoteAnchor,
): { start: number; end: number } | null {
  const { exact, prefix, suffix } = anchor;
  if (!exact) return null;

  const occurrences: number[] = [];
  let i = text.indexOf(exact);
  while (i !== -1) {
    occurrences.push(i);
    i = text.indexOf(exact, i + 1);
  }
  const first = occurrences[0];
  if (first === undefined) return null;
  if (occurrences.length === 1) {
    return { start: first, end: first + exact.length };
  }

  let best = first;
  let bestScore = -Infinity;
  for (const o of occurrences) {
    let score = 0;
    if (prefix) {
      const pfx = text.slice(Math.max(0, o - prefix.length), o);
      if (pfx.endsWith(prefix)) score += 2;
      else if (prefix.length >= 4 && pfx.endsWith(prefix.slice(-4))) score += 1;
    }
    if (suffix) {
      const sfx = text.slice(o + exact.length, o + exact.length + suffix.length);
      if (sfx.startsWith(suffix)) score += 2;
      else if (suffix.length >= 4 && sfx.startsWith(suffix.slice(0, 4))) score += 1;
    }
    const closer = Math.abs(o - anchor.start) < Math.abs(best - anchor.start);
    if (score > bestScore || (score === bestScore && closer)) {
      best = o;
      bestScore = score;
    }
  }
  return { start: best, end: best + exact.length };
}

// Wrap [start, end) of the article text in <mark> elements (one per crossed
// text node), tagging them with the group id and a comment count.
function highlightRange(
  root: HTMLElement,
  start: number,
  end: number,
  groupId: string,
  count: number,
): HTMLElement[] {
  const { segments } = collectSegments(root);
  const marks: HTMLElement[] = [];
  for (const seg of segments) {
    const s = Math.max(start, seg.start);
    const e = Math.min(end, seg.end);
    if (s >= e) continue;
    const range = document.createRange();
    try {
      range.setStart(seg.node, s - seg.start);
      range.setEnd(seg.node, e - seg.start);
      const mark = document.createElement("mark");
      mark.className = "inline-comment-highlight";
      mark.dataset.groupId = groupId;
      range.surroundContents(mark);
      marks.push(mark);
    } catch {
      // range crosses an element boundary within this segment; skip it
    }
  }
  const lastMark = marks[marks.length - 1];
  if (count > 1 && lastMark) {
    const badge = document.createElement("span");
    badge.className = "inline-comment-count";
    badge.setAttribute("data-inline-comment-ignore", "");
    badge.textContent = String(count);
    lastMark.appendChild(badge);
  }
  return marks;
}

// ─── comment body <-> anchor marker ─────────────────────────────────────

function parseAnchor(body: string): TextQuoteAnchor | null {
  const m = body.match(ANCHOR_RE);
  if (!m || m[1] === undefined) return null;
  try {
    const parsed = JSON.parse(m[1]) as TextQuoteAnchor;
    return typeof parsed.exact === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function formatBody(anchor: TextQuoteAnchor, prose: string): string {
  const quote = anchor.exact
    .split("\n")
    .map((l) => "> " + l)
    .join("\n");
  const marker = `<!-- quartz-anchor: ${JSON.stringify(anchor)} -->`;
  return `${quote}\n\n${prose.trim()}\n\n${marker}`;
}

// Strip the leading quote blockquote we injected so the thread UI doesn't
// duplicate the highlighted text. GitHub already drops the HTML comment.
function displayHTML(bodyHTML: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = bodyHTML.trim();
  const first = tpl.content.firstElementChild;
  if (first && first.tagName === "BLOCKQUOTE") first.remove();
  return tpl.innerHTML;
}

// ─── auth ───────────────────────────────────────────────────────────────

// A GitHub App issues user-to-server tokens that expire (8h by default) plus a
// refresh token (~6 months). If the App has expiration disabled, GitHub omits
// those fields and `expiresAt` stays null, meaning "never expires".
type Session = {
  token: string;
  expiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
};

// Refresh this far before actual expiry so a request can't die mid-flight.
const EXPIRY_SKEW_MS = 60_000;

function readSession(): Session | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token !== "string") return null;
    return {
      token: parsed.token,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
      refreshExpiresAt:
        typeof parsed.refreshExpiresAt === "number" ? parsed.refreshExpiresAt : null,
    };
  } catch {
    // legacy format: a bare token string from the pre-GitHub-App version
    return { token: raw, expiresAt: null, refreshToken: null, refreshExpiresAt: null };
  }
}

function writeSession(s: Session): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
}

function isExpired(at: number | null): boolean {
  return at !== null && Date.now() >= at - EXPIRY_SKEW_MS;
}

// The currently usable token, or null if absent/expired. Callers that can
// perform a refresh should use InlineComments#ensureToken instead.
function getToken(): string | null {
  const s = readSession();
  if (!s || isExpired(s.expiresAt)) return null;
  return s.token;
}

// True when we hold a token that's merely expired but still refreshable —
// used to keep the composer showing "signed in" rather than flashing signed-out.
function canRefresh(): boolean {
  const s = readSession();
  return !!s?.refreshToken && !isExpired(s.refreshExpiresAt);
}

function isSignedIn(): boolean {
  return getToken() !== null || canRefresh();
}

async function refreshSession(cfg: Config): Promise<string | null> {
  const s = readSession();
  if (!s?.refreshToken || isExpired(s.refreshExpiresAt)) return null;
  try {
    const res = await fetch(`${cfg.apiBase}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    });
    if (!res.ok) {
      clearToken();
      return null;
    }
    const next = (await res.json()) as Session;
    if (!next?.token) {
      clearToken();
      return null;
    }
    writeSession(next);
    return next.token;
  } catch {
    return null;
  }
}

function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(VIEWER_KEY);
}

// The signed-in user, cached so the composer can show "signed in as @x"
// without a round-trip on every popover open.
function getCachedViewer(): CommentAuthor | null {
  const raw = localStorage.getItem(VIEWER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CommentAuthor;
  } catch {
    return null;
  }
}

async function fetchViewer(token: string): Promise<CommentAuthor | null> {
  const cached = getCachedViewer();
  if (cached) return cached;
  try {
    const data = await graphql<{ viewer: CommentAuthor }>(
      token,
      `
        query {
          viewer {
            login
            avatarUrl
          }
        }
      `,
      {},
    );
    localStorage.setItem(VIEWER_KEY, JSON.stringify(data.viewer));
    return data.viewer;
  } catch {
    return null;
  }
}

function randomState(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function login(cfg: Config): Promise<string> {
  return new Promise((resolve, reject) => {
    const state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    const apiOrigin = new URL(cfg.apiBase).origin;
    const loginUrl =
      `${cfg.apiBase}/api/auth/login?state=${encodeURIComponent(state)}` +
      `&origin=${encodeURIComponent(location.origin)}`;
    const popup = window.open(loginUrl, "inline-comments-login", "width=600,height=720");
    if (!popup) {
      reject(new Error("popup blocked"));
      return;
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== apiOrigin) return;
      const data = e.data as Partial<Session> & { type?: string; state?: string };
      if (data?.type !== "inline-comments-token") return;
      window.removeEventListener("message", onMessage);
      if (data.state && data.state !== state) {
        reject(new Error("oauth state mismatch"));
        return;
      }
      if (!data.token) {
        reject(new Error("no token returned"));
        return;
      }
      writeSession({
        token: data.token,
        expiresAt: data.expiresAt ?? null,
        refreshToken: data.refreshToken ?? null,
        refreshExpiresAt: data.refreshExpiresAt ?? null,
      });
      resolve(data.token);
    };
    window.addEventListener("message", onMessage);
  });
}

// ─── github i/o ─────────────────────────────────────────────────────────

async function fetchComments(cfg: Config, term: string): Promise<CommentsResponse> {
  const empty: CommentsResponse = { discussionId: null, discussionNumber: null, comments: [] };
  if (!cfg.apiBase) return empty;
  const token = getToken();
  const url =
    `${cfg.apiBase}/api/comments?repo=${encodeURIComponent(cfg.repo)}` +
    `&category=${encodeURIComponent(cfg.category)}&term=${encodeURIComponent(term)}`;
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return empty;
    return (await res.json()) as CommentsResponse;
  } catch {
    return empty;
  }
}

async function graphql<T>(token: string, query: string, variables: object): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("GitHub session expired — please sign in again.");
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0]?.message ?? "GraphQL error");
  if (!json.data) throw new Error("empty GraphQL response");
  return json.data;
}

const CREATE_DISCUSSION = `
mutation ($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
  createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) {
    discussion { id }
  }
}`;

const ADD_COMMENT = `
mutation ($discussionId: ID!, $body: String!, $replyToId: ID) {
  addDiscussionComment(input: { discussionId: $discussionId, body: $body, replyToId: $replyToId }) {
    comment { id url createdAt bodyHTML body author { login avatarUrl } }
  }
}`;

async function ensureDiscussion(
  token: string,
  cfg: Config,
  term: string,
  current: CommentsResponse,
): Promise<string> {
  if (current.discussionId) return current.discussionId;
  const data = await graphql<{ createDiscussion: { discussion: { id: string } } }>(
    token,
    CREATE_DISCUSSION,
    {
      repoId: cfg.repoId,
      categoryId: cfg.categoryId,
      title: term,
      body: `Comments for \`${term}\``,
    },
  );
  return data.createDiscussion.discussion.id;
}

async function addComment(
  token: string,
  discussionId: string,
  body: string,
  replyToId?: string,
): Promise<RawComment> {
  const data = await graphql<{ addDiscussionComment: { comment: RawComment } }>(
    token,
    ADD_COMMENT,
    {
      discussionId,
      body,
      replyToId: replyToId ?? null,
    },
  );
  return data.addDiscussionComment.comment;
}

// ─── floating UI helpers ────────────────────────────────────────────────

type Cleanup = () => void;

function anchorFloating(
  reference: HTMLElement | { getBoundingClientRect: () => DOMRect },
  floating: HTMLElement,
): Cleanup {
  return autoUpdate(reference as HTMLElement, floating, () => {
    computePosition(reference as HTMLElement, floating, {
      strategy: "fixed",
      placement: "top",
      middleware: [offset(8), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      Object.assign(floating.style, { left: `${x}px`, top: `${y}px` });
    });
  });
}

function virtualRef(range: Range) {
  return { getBoundingClientRect: () => range.getBoundingClientRect() };
}

// ─── main ───────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = secs;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  for (const [size, u] of units) {
    if (Math.abs(value) < size) {
      unit = u;
      break;
    }
    value = Math.round(value / size);
    unit = u;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-value, unit);
}

function commentItemEl(c: RawComment, isReply: boolean): HTMLElement {
  const item = document.createElement("div");
  item.className = isReply ? "inline-comment-item reply" : "inline-comment-item";

  const meta = document.createElement("div");
  meta.className = "inline-comment-meta";
  const avatar = document.createElement("img");
  avatar.src = c.author?.avatarUrl ?? "";
  avatar.alt = c.author?.login ?? "";
  const author = document.createElement("a");
  author.className = "inline-comment-author";
  author.textContent = c.author?.login ?? "unknown";
  author.href = c.url;
  author.target = "_blank";
  author.rel = "noopener noreferrer";
  const date = document.createElement("span");
  date.className = "inline-comment-date";
  date.textContent = relTime(c.createdAt);
  meta.append(avatar, author, date);

  const body = document.createElement("div");
  body.className = "inline-comment-body";
  body.innerHTML = displayHTML(c.bodyHTML);

  item.append(meta, body);
  return item;
}

class InlineComments {
  private cfg: Config;
  private root: HTMLElement;
  private term: string;
  private state: CommentsResponse = { discussionId: null, discussionNumber: null, comments: [] };
  private popover: HTMLElement | null = null;
  private popoverCleanups: Cleanup[] = [];
  // groupId -> comments sharing an identical resolved range
  private groups = new Map<string, RawComment[]>();

  constructor(cfg: Config, root: HTMLElement) {
    this.cfg = cfg;
    this.root = root;
    this.term = getTerm(cfg);
  }

  // torn down by quartz's SPA router on the next navigation
  registerCleanup(fn: Cleanup) {
    window.addCleanup(fn);
  }

  // Returns a usable token: the current one, else a silent refresh, else the
  // sign-in popup.
  //
  // `login()` must be reached synchronously from the originating click or the
  // browser blocks the popup. A refresh is an await, so it is only attempted
  // when we actually hold a refresh token — otherwise we go straight to
  // login() with no await in front of it.
  private async ensureToken(): Promise<string> {
    const existing = getToken();
    if (existing) return existing;

    if (canRefresh()) {
      const refreshed = await refreshSession(this.cfg);
      if (refreshed) return refreshed;
      // refresh failed — fall through to sign-in. The popup may be blocked
      // here since we've now awaited; the error surfaces in the composer and
      // a second click (with no refresh token left) opens it cleanly.
    }

    const token = await login(this.cfg);
    await fetchViewer(token);
    return token;
  }

  async start() {
    this.setupSelectionUI();
    await this.render();
  }

  // ── rendering existing comments ──
  async render() {
    this.state = await fetchComments(this.cfg, this.term);
    this.groups.clear();

    const { text } = collectSegments(this.root);
    type Placed = { key: string; start: number; end: number; comments: RawComment[] };
    const placedByRange = new Map<string, Placed>();
    const orphans: RawComment[] = [];

    for (const c of this.state.comments) {
      const anchor = parseAnchor(c.body);
      if (!anchor) continue; // page-level comment → left to the giscus widget
      const resolved = resolveAnchor(text, anchor);
      if (!resolved) {
        orphans.push(c);
        continue;
      }
      const key = `${resolved.start}:${resolved.end}`;
      const existing = placedByRange.get(key);
      if (existing) existing.comments.push(c);
      else placedByRange.set(key, { key, start: resolved.start, end: resolved.end, comments: [c] });
    }

    // wrap ranges last-first so earlier offsets are not invalidated
    const placed = [...placedByRange.values()].sort((a, b) => b.start - a.start);
    for (const p of placed) {
      this.groups.set(p.key, p.comments);
      const marks = highlightRange(this.root, p.start, p.end, p.key, p.comments.length);
      for (const mark of marks) {
        mark.addEventListener("click", (e) => {
          e.preventDefault();
          this.openThread(p.key, mark);
        });
      }
    }

    this.renderOrphans(orphans);
  }

  renderOrphans(orphans: RawComment[]) {
    document.querySelector(".inline-comments-orphans")?.remove();
    if (orphans.length === 0) return;
    const wrap = document.createElement("section");
    wrap.className = "inline-comments-orphans";
    const h = document.createElement("h3");
    h.textContent = `Comments on earlier revisions (${orphans.length})`;
    wrap.appendChild(h);
    for (const c of orphans) wrap.appendChild(commentItemEl(c, false));
    this.root.after(wrap);
    this.registerCleanup(() => wrap.remove());
  }

  // ── selection → add button ──
  setupSelectionUI() {
    const btn = document.createElement("button");
    btn.className = "inline-comment-add";
    btn.setAttribute("data-inline-comment-ignore", "");
    btn.innerHTML =
      `<svg viewBox="0 0 24 24" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>` +
      `<span>Comment</span>`;
    btn.style.left = "0";
    btn.style.top = "0";
    document.body.appendChild(btn);
    this.registerCleanup(() => btn.remove());

    let pendingRange: Range | null = null;
    let btnCleanup: Cleanup | null = null;

    const hide = () => {
      btn.classList.remove("visible");
      btnCleanup?.();
      btnCleanup = null;
    };

    const onSelect = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hide();
      const range = sel.getRangeAt(0);
      if (!this.root.contains(range.commonAncestorContainer) || !range.toString().trim()) {
        return hide();
      }
      pendingRange = range.cloneRange();
      btnCleanup?.();
      btnCleanup = anchorFloating(virtualRef(range), btn);
      btn.classList.add("visible");
    };

    const onDocMouseDown = (e: MouseEvent) => {
      if (e.target instanceof Node && (btn.contains(e.target) || this.popover?.contains(e.target)))
        return;
      // let the browser update the selection first
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hide();
      }, 0);
    };

    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (pendingRange) this.openComposer(pendingRange);
      hide();
    });
    document.addEventListener("mouseup", onSelect);
    document.addEventListener("mousedown", onDocMouseDown);
    this.registerCleanup(() => {
      document.removeEventListener("mouseup", onSelect);
      document.removeEventListener("mousedown", onDocMouseDown);
      btnCleanup?.();
    });
  }

  // ── popover plumbing ──
  private closePopover() {
    this.popoverCleanups.forEach((fn) => fn());
    this.popoverCleanups = [];
    this.popover?.remove();
    this.popover = null;
  }

  private openPopover(
    reference: HTMLElement | { getBoundingClientRect: () => DOMRect },
    build: (el: HTMLElement) => void,
  ) {
    this.closePopover();
    const el = document.createElement("div");
    el.className = "inline-comment-popover";
    el.setAttribute("data-inline-comment-ignore", "");
    build(el);
    document.body.appendChild(el);
    this.popover = el;
    this.popoverCleanups.push(anchorFloating(reference, el));

    const onOutside = (e: MouseEvent) => {
      if (e.target instanceof Node && !el.contains(e.target)) this.closePopover();
    };
    setTimeout(() => document.addEventListener("mousedown", onOutside), 0);
    this.popoverCleanups.push(() => document.removeEventListener("mousedown", onOutside));

    // ensure the popover is also cleaned up if the user navigates away
    this.registerCleanup(() => this.closePopover());
  }

  private quoteEl(exact: string): HTMLElement {
    const q = document.createElement("blockquote");
    q.className = "inline-comment-quote";
    q.textContent = exact;
    return q;
  }

  private composerEl(
    submitLabel: string,
    onSubmit: (text: string, setBusy: (b: boolean) => void) => void,
  ): HTMLElement {
    const composer = document.createElement("div");
    composer.className = "inline-comment-composer";
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Add a comment…";
    const actions = document.createElement("div");
    actions.className = "inline-comment-actions";
    const hint = document.createElement("span");
    hint.className = "inline-comment-hint";
    const submit = document.createElement("button");
    submit.className = "inline-comment-submit";
    submit.textContent = submitLabel;
    submit.disabled = true;

    // auth row — sign-in is offered here rather than only at the page bottom
    const auth = document.createElement("div");
    auth.className = "inline-comment-auth";

    const setBusy = (b: boolean) => {
      submit.disabled = b || textarea.value.trim().length === 0;
      submit.textContent = b ? "Posting…" : submitLabel;
    };
    const showHint = (msg: string) => (hint.textContent = msg);

    const renderAuth = () => {
      auth.replaceChildren();
      // an expired-but-refreshable session still counts as signed in, so the
      // row doesn't flash "signed out" every 8 hours
      if (!isSignedIn()) {
        const signIn = document.createElement("button");
        signIn.className = "inline-comment-signin";
        signIn.type = "button";
        signIn.innerHTML =
          `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>` +
          `<span>Sign in with GitHub</span>`;
        signIn.addEventListener("click", async () => {
          // must call login() synchronously in the click handler or the
          // popup gets blocked
          try {
            signIn.disabled = true;
            const t = await login(this.cfg);
            await fetchViewer(t);
            showHint("");
            renderAuth();
            textarea.focus();
          } catch (err) {
            signIn.disabled = false;
            showHint(err instanceof Error ? err.message : "Sign-in failed.");
          }
        });
        auth.append(signIn);
        return;
      }

      const who = document.createElement("span");
      who.className = "inline-comment-whoami";
      const viewer = getCachedViewer();
      if (viewer) {
        const avatar = document.createElement("img");
        avatar.src = viewer.avatarUrl;
        avatar.alt = viewer.login;
        who.append(avatar, document.createTextNode(`@${viewer.login}`));
      } else {
        who.textContent = "Signed in";
        // resolve the login lazily, then re-render. Only possible with a live
        // token; if it's merely refreshable we'll fill this in after the next
        // refresh rather than burning a round-trip here.
        const live = getToken();
        if (live) void fetchViewer(live).then((v) => v && renderAuth());
      }
      const signOut = document.createElement("button");
      signOut.className = "inline-comment-signout";
      signOut.type = "button";
      signOut.textContent = "Sign out";
      signOut.addEventListener("click", () => {
        clearToken();
        renderAuth();
      });
      auth.append(who, signOut);
    };

    textarea.addEventListener("input", () => {
      submit.disabled = textarea.value.trim().length === 0;
    });
    submit.addEventListener("click", () => {
      const text = textarea.value.trim();
      if (text) onSubmit(text, setBusy);
    });
    (composer as HTMLElement & { showHint?: (m: string) => void }).showHint = showHint;
    (composer as HTMLElement & { refreshAuth?: () => void }).refreshAuth = renderAuth;

    renderAuth();
    actions.append(hint, submit);
    composer.append(textarea, auth, actions);
    return composer;
  }

  // ── new comment on a fresh selection ──
  private openComposer(range: Range) {
    const anchor = anchorFromRange(this.root, range);
    if (!anchor) return;
    this.openPopover(virtualRef(range), (el) => {
      el.appendChild(this.quoteEl(anchor.exact));
      const composer = this.composerEl("Comment", async (text, setBusy) => {
        setBusy(true);
        try {
          const token = await this.ensureToken();
          const discussionId = await ensureDiscussion(token, this.cfg, this.term, this.state);
          this.state.discussionId = discussionId;
          await addComment(token, discussionId, formatBody(anchor, text));
          this.closePopover();
          await this.render();
        } catch (err) {
          setBusy(false);
          const showHint = (composer as HTMLElement & { showHint?: (m: string) => void }).showHint;
          showHint?.(err instanceof Error ? err.message : "Failed to post comment.");
        }
      });
      el.appendChild(composer);
    });
  }

  // ── existing thread on a highlight ──
  private openThread(groupId: string, mark: HTMLElement) {
    const comments = this.groups.get(groupId) ?? [];
    const replyTo = comments[0];
    if (!replyTo) return;
    const anchor = parseAnchor(replyTo.body);

    this.openPopover(mark, (el) => {
      if (anchor) el.appendChild(this.quoteEl(anchor.exact));
      const thread = document.createElement("div");
      thread.className = "inline-comment-thread";
      for (const c of comments) {
        thread.appendChild(commentItemEl(c, false));
        for (const r of c.replies ?? []) thread.appendChild(commentItemEl(r, true));
      }
      el.appendChild(thread);

      const composer = this.composerEl("Reply", async (text, setBusy) => {
        setBusy(true);
        try {
          const token = await this.ensureToken();
          const discussionId = this.state.discussionId;
          if (!discussionId) throw new Error("missing discussion");
          await addComment(token, discussionId, text, replyTo.id);
          this.closePopover();
          await this.render();
        } catch (err) {
          setBusy(false);
          const showHint = (composer as HTMLElement & { showHint?: (m: string) => void }).showHint;
          showHint?.(err instanceof Error ? err.message : "Failed to post reply.");
        }
      });
      el.appendChild(composer);
    });
  }
}

// ─── lifecycle ──────────────────────────────────────────────────────────

document.addEventListener("nav", () => {
  const container = document.querySelector(".inline-comments") as HTMLElement | null;
  const root = getRoot();
  if (!container || !root) return;
  const cfg = readConfig(container);
  if (!cfg.apiBase) return; // graceful no-op until the worker is deployed
  const app = new InlineComments(cfg, root);
  void app.start();
});
