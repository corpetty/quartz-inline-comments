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

Then deploy the worker (see [`worker/README.md`](./worker/README.md)) and set
`apiBase` to the deployed URL.

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
