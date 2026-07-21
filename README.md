# quartz-inline-comments

Inline, **anchored** comments for [Quartz 5](https://quartz.jzhao.xyz) — comments
attached to a specific text selection (Medium margin-notes / Hypothes.is style),
not just one thread at the bottom of the page. Backed by **GitHub Discussions**,
authenticated with a **GitHub App**.

See [`docs-internal/inline-comments-design.md`](https://github.com/logos-co/assembly/blob/v5/docs-internal/inline-comments-design.md)
for the full design, and
[`inline-comments-v5-plugin-migration.md`](https://github.com/logos-co/assembly/blob/v5/docs-internal/inline-comments-v5-plugin-migration.md)
for how this plugin was extracted from the v4 site component.

## Requires the worker

This component is the browser half. It needs the companion serverless worker
([`serverless/inline-comments-worker`](https://github.com/logos-co/assembly/tree/v5/serverless/inline-comments-worker))
deployed for auth and anonymous reads. If `apiBase` is empty the component
no-ops (the site builds and renders, just without inline UI).

## Install

While developing in this repo it is wired as a **local** plugin source
(`./plugins/inline-comments`). Published, it installs like any community plugin:

```sh
npx quartz plugin add github:corpetty/quartz-inline-comments
```

## Configure

In `quartz.config.yaml`:

```yaml
plugins:
  - source: ./plugins/inline-comments # or github:corpetty/quartz-inline-comments
    enabled: true
    options:
      repo: logos-co/assembly
      repoId: R_kgDOQUhKqA
      category: Announcements
      categoryId: DIC_kwDOQUhKqM4Cxur2
      apiBase: https://inline-comments.inline-assembly.workers.dev
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
