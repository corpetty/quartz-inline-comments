// Inline Comments worker — the only non-static piece of the system.
//
// Auth is a **GitHub App** (not an OAuth App): permissions come from the App
// definition, so users are asked for fine-grained `Discussions: write` on the
// one repo the App is installed on — never `public_repo` across every public
// repo they own. Consequently no `scope` is sent on the authorize URL.
//
// GitHub Apps issue user-to-server tokens that expire (8h by default) with a
// refresh token (~6 months), hence /api/auth/refresh. If the App has token
// expiration disabled, GitHub simply omits those fields and everything still
// works — the client treats a missing expiry as "never expires".
//
// Endpoints:
//   GET  /api/auth/login?state=&origin=  → 302 to GitHub's authorize URL
//   GET  /api/auth/callback?code=&state= → exchange code → postMessage session to opener
//   POST /api/auth/refresh               → refresh_token → new session (CORS)
//   GET  /api/comments?repo=&category=&term=
//                                        → anonymous read proxy (server token) so
//                                          logged-out visitors can see highlights
//
// Secrets (wrangler secret put ..., or the Cloudflare dashboard as encrypted):
//   GITHUB_CLIENT_ID       GitHub App client id (Iv23li…)
//   GITHUB_CLIENT_SECRET   GitHub App client secret
//   GITHUB_TOKEN           server read token (fine-grained PAT: Discussions read)
// Vars (wrangler.toml [vars]):
//   ALLOWED_ORIGINS        comma-separated site origins, e.g. "https://example.com"

export interface Env {
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  GITHUB_TOKEN: string
  ALLOWED_ORIGINS: string
}

const GITHUB_GRAPHQL = "https://api.github.com/graphql"
const USER_AGENT = "quartz-inline-comments"

// ─── helpers ──────────────────────────────────────────────────────────────

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function isAllowed(origin: string, env: Env): boolean {
  const list = allowedOrigins(env)
  return list.includes("*") || list.includes(origin)
}

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allow = isAllowed(origin, env) ? origin : (allowedOrigins(env)[0] ?? "")
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  }
}

function json(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  })
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4))
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad)
}

async function githubGraphQL<T>(token: string, query: string, variables: object): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors[0].message)
  if (!body.data) throw new Error("empty GraphQL response")
  return body.data
}

// ─── auth: login ────────────────────────────────────────────────────────

function handleLogin(url: URL, env: Env): Response {
  const clientState = url.searchParams.get("state") ?? ""
  const origin = url.searchParams.get("origin") ?? ""
  if (!isAllowed(origin, env)) return new Response("origin not allowed", { status: 403 })

  const ghState = b64urlEncode(JSON.stringify({ cs: clientState, o: origin }))
  const redirectUri = `${url.origin}/api/auth/callback`
  const authorize = new URL("https://github.com/login/oauth/authorize")
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID)
  authorize.searchParams.set("redirect_uri", redirectUri)
  // NOTE: deliberately no `scope` — a GitHub App's permissions are fixed by
  // the App definition. Sending a scope here is what made the OAuth App ask
  // for `public_repo` across all of the user's public repositories.
  authorize.searchParams.set("state", ghState)
  authorize.searchParams.set("allow_signup", "true")
  return Response.redirect(authorize.toString(), 302)
}

// ─── auth: callback ───────────────────────────────────────────────────────

// GitHub's token response. `expires_in` / `refresh_token` are present only
// when the App has expiring user tokens enabled (the default for new Apps).
type TokenResponse = {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

// Absolute epoch-ms expiry, or null when the token never expires.
function absoluteExpiry(seconds: number | undefined, now: number): number | null {
  return typeof seconds === "number" ? now + seconds * 1000 : null
}

function sessionFrom(t: TokenResponse, now: number) {
  return {
    token: t.access_token,
    expiresAt: absoluteExpiry(t.expires_in, now),
    refreshToken: t.refresh_token ?? null,
    refreshExpiresAt: absoluteExpiry(t.refresh_token_expires_in, now),
  }
}

function callbackPage(
  t: TokenResponse,
  clientState: string,
  origin: string,
  now: number,
): Response {
  // JSON-encode + neutralize "</script>" so nothing can break out of the tag.
  const payload = JSON.stringify({
    type: "inline-comments-token",
    state: clientState,
    ...sessionFrom(t, now),
  }).replace(/</g, "\\u003c")
  const targetOrigin = JSON.stringify(origin).replace(/</g, "\\u003c")
  const html = `<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="font-family:sans-serif;padding:2rem">Signing you in…
<script>
(function () {
  var msg = ${payload};
  if (window.opener) { window.opener.postMessage(msg, ${targetOrigin}); }
  window.close();
})();
</script></body>`
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code")
  const ghState = url.searchParams.get("state") ?? ""
  let clientState = ""
  let origin = ""
  try {
    const parsed = JSON.parse(b64urlDecode(ghState)) as { cs: string; o: string }
    clientState = parsed.cs
    origin = parsed.o
  } catch {
    return new Response("invalid state", { status: 400 })
  }
  if (!code || !isAllowed(origin, env)) return new Response("bad request", { status: 400 })

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  })
  const tokenJson = (await res.json()) as TokenResponse
  if (!tokenJson.access_token) {
    const detail = tokenJson.error_description ?? tokenJson.error ?? "unknown"
    return new Response(`oauth error: ${detail}`, { status: 400 })
  }
  return callbackPage(tokenJson, clientState, origin, Date.now())
}

// ─── auth: refresh ────────────────────────────────────────────────────────

// Exchanges a refresh token for a fresh user-to-server token. Needs the client
// secret, which is why it lives here rather than in the browser.
async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") ?? ""
  const cors = corsHeaders(origin, env)
  if (!isAllowed(origin, env)) return json({ error: "origin not allowed" }, 403, cors)

  let refreshToken = ""
  try {
    const body = (await request.json()) as { refresh_token?: string }
    refreshToken = body.refresh_token ?? ""
  } catch {
    return json({ error: "invalid body" }, 400, cors)
  }
  if (!refreshToken) return json({ error: "missing refresh_token" }, 400, cors)

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  })
  const tokenJson = (await res.json()) as TokenResponse
  if (!tokenJson.access_token) {
    // refresh token expired or revoked — the client should re-run sign-in
    const detail = tokenJson.error_description ?? tokenJson.error ?? "unknown"
    return json({ error: detail }, 401, cors)
  }
  return json(sessionFrom(tokenJson, Date.now()), 200, cors)
}

// ─── read proxy: comments ──────────────────────────────────────────────────

type GHComment = {
  id: string
  url: string
  createdAt: string
  bodyHTML: string
  body: string
  author: { login: string; avatarUrl: string } | null
  replies?: { nodes: GHComment[] }
}

type GHDiscussion = {
  id: string
  number: number
  title: string
  category: { name: string }
  comments: { totalCount: number; nodes: GHComment[] }
}

const SEARCH_DISCUSSION = `
query ($q: String!) {
  search(query: $q, type: DISCUSSION, first: 10) {
    nodes {
      ... on Discussion {
        id
        number
        title
        category { name }
        comments(first: 100) {
          totalCount
          nodes {
            id url createdAt bodyHTML body
            author { login avatarUrl }
            replies(first: 100) {
              nodes { id url createdAt bodyHTML body author { login avatarUrl } }
            }
          }
        }
      }
    }
  }
}`

function mapComment(c: GHComment): unknown {
  return {
    id: c.id,
    url: c.url,
    createdAt: c.createdAt,
    bodyHTML: c.bodyHTML,
    body: c.body,
    author: c.author ?? { login: "ghost", avatarUrl: "" },
    replies: (c.replies?.nodes ?? []).map(mapComment),
  }
}

async function handleComments(request: Request, url: URL, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin") ?? ""
  const cors = corsHeaders(origin, env)

  const repo = url.searchParams.get("repo") ?? ""
  const category = url.searchParams.get("category") ?? ""
  const term = url.searchParams.get("term") ?? ""
  const [owner, name] = repo.split("/")
  if (!owner || !name || !term) return json({ error: "missing repo/term" }, 400, cors)

  // A logged-in reader may pass their own token; else use the server token.
  const authHeader = request.headers.get("Authorization")
  const token =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : env.GITHUB_TOKEN
  if (!token) return json({ error: "no token configured" }, 500, cors)

  const q = `repo:${owner}/${name} in:title "${term.replace(/"/g, "")}"`
  try {
    const data = await githubGraphQL<{ search: { nodes: GHDiscussion[] } }>(
      token,
      SEARCH_DISCUSSION,
      {
        q,
      },
    )
    const matches = data.search.nodes.filter(
      (d) => d && d.title === term && (!category || d.category?.name === category),
    )
    if (matches.length === 0) {
      return json({ discussionId: null, discussionNumber: null, comments: [] }, 200, cors)
    }
    // Two discussions can share a title — giscus races and creates a duplicate
    // if a page is opened twice at once (see #11/#12 in this repo). Search
    // order is not guaranteed, so picking the first match could silently land
    // on the empty twin and show no comments at all. Prefer the one actually
    // holding the conversation, tie-breaking on the lower number for stability.
    const match = matches.reduce((best, d) => {
      const better = d.comments.totalCount > best.comments.totalCount
      const tie = d.comments.totalCount === best.comments.totalCount && d.number < best.number
      return better || tie ? d : best
    })
    return json(
      {
        discussionId: match.id,
        discussionNumber: match.number,
        comments: match.comments.nodes.map(mapComment),
      },
      200,
      cors,
    )
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "read failed" }, 502, cors)
  }
}

// ─── router ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get("Origin") ?? "", env),
      })
    }

    switch (url.pathname) {
      case "/api/auth/login":
        return handleLogin(url, env)
      case "/api/auth/callback":
        return handleCallback(url, env)
      case "/api/auth/refresh":
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
        return handleRefresh(request, env)
      case "/api/comments":
        return handleComments(request, url, env)
      default:
        return new Response("not found", { status: 404 })
    }
  },
}
