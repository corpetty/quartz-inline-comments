import type {
  QuartzComponent,
  QuartzComponentConstructor,
  QuartzComponentProps,
} from "@quartz-community/types";
import { classNames } from "../util/lang";
import style from "./styles/inlineComments.scss";
// @ts-expect-error - inline script import handled by the Quartz bundler
import script from "./scripts/inlineComments.inline.ts";

export interface InlineCommentsOptions {
  // owner/name of the repo holding the Discussions, e.g. "you/your-repo"
  repo?: string;
  // GraphQL node id of the repo (data-repo-id in giscus config)
  repoId?: string;
  // Discussion category name, e.g. "Announcements"
  category?: string;
  // GraphQL node id of the category (data-category-id in giscus config)
  categoryId?: string;
  // Base URL of the serverless worker (OAuth exchange + anonymous read proxy).
  // If empty, the client no-ops gracefully and nothing is rendered.
  apiBase?: string;
  // how a page maps to a discussion "term". Matches the existing giscus mapping.
  mapping?: "url" | "pathname" | "title";
}

export default ((opts?: InlineCommentsOptions) => {
  const {
    repo = "",
    repoId = "",
    category = "",
    categoryId = "",
    apiBase = "",
    mapping = "url",
  } = opts ?? {};

  const InlineComments: QuartzComponent = ({
    displayClass,
    fileData,
    cfg,
  }: QuartzComponentProps) => {
    // respect the same frontmatter opt-out as the built-in Comments component
    const comments = fileData.frontmatter?.comments as boolean | string | undefined;
    const disableComment = typeof comments !== "undefined" && (!comments || comments === "false");
    if (disableComment) {
      return <></>;
    }

    return (
      <div
        class={classNames(displayClass, "inline-comments")}
        data-repo={repo}
        data-repo-id={repoId}
        data-category={category}
        data-category-id={categoryId}
        data-api-base={apiBase}
        data-mapping={mapping}
        data-base-url={cfg.baseUrl ?? ""}
      ></div>
    );
  };

  InlineComments.afterDOMLoaded = script;
  InlineComments.css = style;

  return InlineComments;
}) satisfies QuartzComponentConstructor;
