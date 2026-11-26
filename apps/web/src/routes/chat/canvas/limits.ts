import { CSV_TABLE_MAX_CELL, CSV_TABLE_MAX_COLS } from '@/lib/utils/csvTable';

/**
 * What the canvas fetches and shows of a document, moved from the sandbox
 * outputs' renderers (docs/guides/sandbox.md, "Outputs").
 */

/** The most of a text document fetched and shown; past it, the start is shown and the rest is a download. */
export const TEXT_MAX_BYTES = 256 * 1024;
export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 200;
/** A hostile CSV (a megabyte of commas) must stay a small table. */
export const CSV_MAX_COLS = CSV_TABLE_MAX_COLS;
export const CSV_MAX_CELL = CSV_TABLE_MAX_CELL;
/** The HTML route's own limit (routers/sandbox.py, 413 over it); a larger file is not asked for. */
export const HTML_MAX_BYTES = 5 * 1024 * 1024;
/** Source longer than this many lines is shown without per-line highlighting, which would stall the panel. */
export const HIGHLIGHT_MAX_LINES = 2000;
