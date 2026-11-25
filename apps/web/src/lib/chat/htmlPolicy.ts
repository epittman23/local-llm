/**
 * The content-security policy put in front of model-written HTML before it
 * runs in the canvas's frame. A sandbox output gets it from the server
 * (`with_policy` in apps/server/local_llm/sandbox/outputs.py); a fenced html
 * or svg block is already in the browser, so it gets the same text here. A
 * Vitest test compares this with `HTML_POLICY` in outputs.py, so the two
 * cannot drift apart.
 */
export const HTML_POLICY_CONTENT =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";

export const HTML_POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_POLICY_CONTENT}">`;

// Only HTML whitespace may come before a doctype the policy goes after: anything else the parser reads as text,
// which opens <body>, and a policy <meta> outside <head> is ignored. ASCII only, as the parser matches DOCTYPE.
const DOCTYPE = /^[\t\n\f\r ]*<!doctype[^>]*>/i;

/** `document` with the policy as its first element, after a leading doctype if it has one (`with_policy`). */
export function withHtmlPolicy(document: string): string {
	const at = DOCTYPE.exec(document)?.[0].length ?? 0;
	return document.slice(0, at) + HTML_POLICY_META + document.slice(at);
}
