import hljs from 'highlight.js/lib/common';
import latex from 'highlight.js/lib/languages/latex';

// The common set has no LaTeX, which the canvas shows `.tex` documents in.
// One registration here, so every code surface (chat blocks, Source, the
// editor) highlights the same languages.
hljs.registerLanguage('latex', latex);

export { hljs };
