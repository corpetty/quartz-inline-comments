# quartz-inline-comments

Inline, **anchored** comments for [Quartz 5](https://quartz.jzhao.xyz) — comments
attached to a specific text selection (Medium margin-notes / Hypothes.is style),
not just one thread at the bottom of the page. Backed by **GitHub Discussions**,
authenticated with a **GitHub App**.

## Repo layout

This repo is self-contained — both halves of the system live here:

| Path        | What                                                              |
| ----------- | ----------------------------------------------------------------- |
| `src/`      | the Quartz 5 plugin (browser half: component, styles, client JS)  |
| `worker/`   | the companion Cloudflare Worker (auth + anonymous read proxy)     |

## Requires the worker

`src/` is only the browser half. It needs the companion serverless worker in
[`worker/`](./worker) deployed for auth and anonymous reads — it holds the two
secrets that can't live in the browser. See
[`worker/README.md`](./worker/README.md) for the full deploy walkthrough.

If `apiBase` is empty the component no-ops (the site builds and renders, just
without inline UI), so it's safe to install the plugin before the worker exists.

The worker is generic: repo, category, and page term arrive as query parameters
from the client, so one deployment can serve any site. The only
deployment-specific config is `ALLOWED_ORIGINS` and three secrets.

## Install

```sh
npx quartz plugin add github:corpetty/quartz-inline-comments
```

That clones the whole repo — **worker included** — into your site at
`.quartz/plugins/quartz-inline-comments/`. There is no second repo to clone;
deploy the worker straight from there:

```sh
cd .quartz/plugins/quartz-inline-comments/worker
npm install
npx wrangler deploy --var ALLOWED_ORIGINS:"https://your-site.com,http://localhost:8080"
```

Then set `apiBase` to the printed URL. Full walkthrough (GitHub App, secrets)
in [`worker/README.md`](./worker/README.md).

> [!note]
> `.quartz/plugins/` is generated and git-ignored — `quartz plugin install`
> re-clones it, discarding local edits. Configure the worker via `--var` and
> `wrangler secret` (both live in the deployment, not the checkout) rather than
> by editing files there.

## Configure

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
      mapping: url # match giscus's mapping to share the same discussion
```

`repoId` / `categoryId` are the GraphQL node ids. Fetch them with:

```sh
gh api graphql -f query='{ repository(owner:"OWNER", name:"REPO") {
  id  discussionCategories(first:20){ nodes { id name } } } }'
```

## Options

| Option       | Type                             | Notes                                             |
| ------------ | -------------------------------- | ------------------------------------------------- |
| `repo`       | `string`                         | `owner/name` of the Discussions repo              |
| `repoId`     | `string`                         | repository GraphQL node id                        |
| `category`   | `string`                         | Discussion category name                          |
| `categoryId` | `string`                         | category GraphQL node id                          |
| `apiBase`    | `string`                         | worker base URL; empty ⇒ no-op                    |
| `mapping`    | `"url" \| "pathname" \| "title"` | page → discussion term; match giscus to share one |

## Layout

The manifest places the component at `afterBody`. Override per the Quartz 5
layout config if you want it elsewhere.

## Build

```sh
npm install
npm run build       # tsup → dist/ (ESM + d.ts)
npm run typecheck
```

> [!important] `dist/` is committed on purpose
> Quartz 5 uses a plugin's committed `dist/` directly and skips the
> install-and-build cycle, so installs are near-instant instead of taking
> ~10s. The trade-off is that `dist/` can go stale: if you change anything in
> `src/` and don't rebuild, every site installing this plugin silently keeps
> getting the old code.
>
> **Run `npm run build` and commit `dist/` in the same commit as any `src/`
> change.** If you'd rather not, re-adding `dist/` to `.gitignore` restores the
> slower build-on-install behavior, which cannot go stale.
