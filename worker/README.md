# Inline Comments Worker

The serverless half of [quartz-inline-comments](../). The plugin's browser
component is inert on its own — it needs this worker deployed, because two
secrets can't live in the browser (the GitHub App client secret and the server
read token).

| Route                    | Purpose                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `GET /api/auth/login`    | Redirect to GitHub's authorize URL                                        |
| `GET /api/auth/callback` | Exchange `code` → user session, `postMessage` it back to the opener       |
| `POST /api/auth/refresh` | Exchange a refresh token for a fresh user token                           |
| `GET /api/comments`      | Anonymous read proxy (server token) so logged-out visitors see highlights |

**Writes never touch this worker** — the browser posts comments straight to
GitHub's GraphQL API with the signed-in user's own token.

The worker is generic: the repo, category, and page term all arrive as query
parameters from the client, so a single deployment can serve any site. The only
deployment-specific configuration is `ALLOWED_ORIGINS` and the three secrets.

Auth is a **GitHub App**, not an OAuth App. That matters: an OAuth App would
have to request the `public_repo` scope, which grants write access to _every_
public repo the commenter owns. A GitHub App's permissions are fixed by the App
definition, so commenters grant only **`Discussions: write` on your one repo**.
No `scope` is sent on the authorize URL as a result.

> **Order matters.** The App's callback URL must contain the worker's URL, and
> the worker's URL doesn't exist until it's deployed — so deploy first.
> Deploying without secrets is fine; those endpoints simply error until you
> add them.

## 1. Deploy the worker (Cloudflare Workers)

```sh
cd worker
npm install
npx wrangler login     # first run also prompts you to pick your workers.dev subdomain
npx wrangler deploy    # prints the URL
```

The printed URL is `https://<name>.<your-subdomain>.workers.dev`, where `<name>`
is `name` in `wrangler.toml`. Save it — it becomes the plugin's `apiBase`.

## 2. Create a GitHub App

<https://github.com/settings/apps> → **New GitHub App** (or create it under an
org if you'd rather ownership not be tied to one person).

| Setting                                                    | Value                                    |
| ---------------------------------------------------------- | ---------------------------------------- |
| **GitHub App name**                                        | anything, e.g. `My Site Inline Comments` |
| **Homepage URL**                                           | your site URL                            |
| **Callback URL**                                           | `<worker-url>/api/auth/callback`         |
| **Request user authorization (OAuth) during installation** | ✅ **check this**                        |
| **Expire user authorization tokens**                       | ✅ leave checked (see below)             |
| **Webhook → Active**                                       | ❌ uncheck — we don't use webhooks       |
| **Repository permissions → Discussions**                   | **Read and write**                       |
| **Where can this GitHub App be installed?**                | Only on this account                     |

Everything else can stay at its default. Then:

1. **Create GitHub App.**
2. Copy the **Client ID** (`Iv23li…`) and **Generate a new client secret** —
   copy it immediately, it's shown once.
3. **Install App** → install it on the repo whose Discussions hold your
   comments (choose "Only select repositories" and pick just that one).
   Without this install step the App can't touch the repo's Discussions.

Add a **second callback URL** on the same App for local dev —
`http://localhost:8787/api/auth/callback`. Unlike OAuth Apps, a GitHub App
accepts multiple callback URLs, so one App covers both prod and dev.

> **On token expiration.** With "Expire user authorization tokens" enabled,
> user tokens last 8 hours and come with a ~6-month refresh token; the client
> refreshes silently via `POST /api/auth/refresh`. If you disable expiration,
> GitHub omits those fields and the client treats the token as non-expiring —
> both paths work, so keep the secure default.
>
> A GitHub App is **not** subject to an org's OAuth App access restrictions;
> it's governed by installation instead.

## 3. Create the server read token

A **fine-grained PAT** (<https://github.com/settings/tokens?type=beta>) scoped to
your comments repo with **Discussions: read**. This lets anonymous visitors load
existing comments. Store it as `GITHUB_TOKEN`.

## 4. Set secrets and origins

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put GITHUB_TOKEN
```

Secrets apply immediately. `ALLOWED_ORIGINS` lives in `wrangler.toml` `[vars]`
and **requires a redeploy** to take effect. Set it to your site's origin
(scheme + host, no path):

```toml
[vars]
ALLOWED_ORIGINS = "https://your-site.com,http://localhost:8080"
```

```sh
npx wrangler deploy
```

### Local dev

```sh
cp .dev.vars.example .dev.vars   # fill in the three secrets (git-ignored)
npm run dev                      # serves on http://localhost:8787
```

Keep `http://localhost:8080` in `ALLOWED_ORIGINS` for Quartz's dev server.

## 5. Point the plugin at the worker

In `quartz.config.yaml`:

```yaml
plugins:
  - source: github:corpetty/quartz-inline-comments
    enabled: true
    options:
      repo: you/your-repo
      repoId: R_kgDO…
      category: Announcements
      categoryId: DIC_kwDO…
      apiBase: https://<name>.<your-subdomain>.workers.dev
      mapping: url # must match giscus's mapping to share a discussion
```

If `apiBase` is empty the component no-ops, so it's safe to land before the
worker exists.

## Notes / limits

- Comments + replies are fetched 100-at-a-time (no pagination yet).
- `mapping` must match on read and write. To share the _same_ discussion as an
  existing giscus widget, use the mapping giscus is configured with.
- Ports to Vercel/Netlify functions are straightforward — the handler is a
  single `fetch(request, env)`; only the deploy wrapper changes.
