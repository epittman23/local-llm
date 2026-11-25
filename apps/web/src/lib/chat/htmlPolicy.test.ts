import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HTML_POLICY_CONTENT, HTML_POLICY_META, withHtmlPolicy } from './htmlPolicy';

describe('HTML policy', () => {
	it('is the text of HTML_POLICY in sandbox/outputs.py', () => {
		// `import.meta.url` is not a file: URL under jsdom, so the path comes from this file's directory.
		const py = readFileSync(resolve(__dirname, '../../../../server/local_llm/sandbox/outputs.py'), 'utf8');
		const assignment = /^HTML_POLICY: Final = \(\n([\s\S]*?)\n\)$/m.exec(py);
		expect(assignment).not.toBeNull();
		// The adjacent string literals, joined as Python joins them.
		const literals = [...(assignment?.[1] ?? '').matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*$/gm)].map((m) =>
			m[1].replace(/\\(.)/g, '$1')
		);
		expect(literals.length).toBeGreaterThan(1);
		expect(literals.join('')).toBe(HTML_POLICY_META);
		expect(HTML_POLICY_META).toContain(`content="${HTML_POLICY_CONTENT}"`);
	});

	it('goes right after a leading doctype', () => {
		const rest = '<script>alert(1)</script><head></head>';
		for (const doctype of [
			'<!DOCTYPE html>',
			'<!doctype html>',
			'\n \t\r\f<!DocType html>',
			'<!DOCTYPEhtml>',
			'<!DOCTYPE "a>'
		]) {
			expect(withHtmlPolicy(doctype + rest)).toBe(doctype + HTML_POLICY_META + rest);
		}
	});

	it('goes first without a doctype', () => {
		const doc = '<html><head><title>t</title></head><body></body></html>';
		expect(withHtmlPolicy(doc)).toBe(HTML_POLICY_META + doc);
		expect(withHtmlPolicy('')).toBe(HTML_POLICY_META);
	});

	it('goes first when a BOM, an NBSP or a comment comes before the doctype', () => {
		for (const lead of ['﻿', ' ', '<!-- c -->']) {
			const doc = `${lead}<!doctype html><p>x</p>`;
			expect(withHtmlPolicy(doc)).toBe(HTML_POLICY_META + doc);
		}
	});

	it('comes before a script placed ahead of <head>, and keeps a policy the document declares', () => {
		const out = withHtmlPolicy('<script>1</script><meta http-equiv="Content-Security-Policy" content="default-src *">');
		expect(out.indexOf(HTML_POLICY_META)).toBeLessThan(out.indexOf('<script>'));
		expect(out.indexOf(HTML_POLICY_META)).toBeLessThan(out.indexOf('default-src *'));
	});
});
