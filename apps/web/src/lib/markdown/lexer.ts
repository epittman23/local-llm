import { Marked } from 'marked';
import markedExtension from './extensions/extension';
import citationExtension from './extensions/citation-extension';
import colonFenceExtension from './extensions/colon-fence-extension';
import footnoteExtension from './extensions/footnote-extension';
import markedKatexExtension from './extensions/katex-extension';
import { mentionExtension } from './extensions/mention-extension';
import { disableSingleTilde } from './extensions/strikethrough-extension';
import { processResponseContent, replaceTokens } from './content';

// The chat's own Marked instance, configured as Markdown.svelte configures the
// global one. It is separate on purpose: SafeMarkdown and the Benchmarks
// report use the global `marked`, and must not start tokenizing `$math$`,
// citations or <details> blocks.
const chatMarked = new Marked();
chatMarked.use(markedKatexExtension({ throwOnError: false }));
chatMarked.use(markedExtension());
chatMarked.use(citationExtension());
chatMarked.use(footnoteExtension());
chatMarked.use(colonFenceExtension());
chatMarked.use(disableSingleTilde);
chatMarked.use({ extensions: [mentionExtension({ triggerChar: '@' }), mentionExtension({ triggerChar: '#' }), mentionExtension({ triggerChar: '$' })] as never });

// Loosely typed: the extensions add token types marked's own union does not know.
export type MdToken = { type: string; raw: string } & Record<string, any>;

/** Tokenizes Markdown with the chat extensions (no preprocessing). */
export const lexChat = (src: string) => chatMarked.lexer(src) as unknown as MdToken[];

/** A message's content as tokens: placeholders filled, then tokenized. */
export const lexMessage = (content: string, modelName?: string, userName?: string) => lexChat(replaceTokens(processResponseContent(content ?? ''), modelName, userName));
