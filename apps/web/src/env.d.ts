/// <reference types="astro/client" />

// Injected by astro.config.mjs's vite.define (mirrors apps/openwebui/vite.config.ts's
// own define block), read by src/lib/constants.ts exactly as the SvelteKit app reads
// them -- see that file's own comment.
declare const APP_VERSION: string;
declare const APP_BUILD_HASH: string;
