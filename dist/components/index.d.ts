import { QuartzComponent } from '@quartz-community/types';

interface InlineCommentsOptions {
    repo?: string;
    repoId?: string;
    category?: string;
    categoryId?: string;
    apiBase?: string;
    mapping?: "url" | "pathname" | "title";
}
declare const _default: (opts?: InlineCommentsOptions) => QuartzComponent;

export { _default as InlineComments, type InlineCommentsOptions };
