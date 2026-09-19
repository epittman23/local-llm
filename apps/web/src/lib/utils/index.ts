export { cn } from "cn"

// Ports apps/openwebui/src/lib/utils/index.ts's `formatNumber` (workspace tab
// counts): 1234 -> "1.2k".
export const formatNumber = (num: number): string =>
	new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
		.format(num)
		.toLowerCase();

// Ports of the same-named helpers in apps/openwebui/src/lib/utils/index.ts.
export const capitalizeFirstLetter = (text: string) =>
	text.charAt(0).toUpperCase() + text.slice(1);

// Prompt commands and similar identifiers: accents stripped, whitespace to
// hyphens, everything outside [a-zA-Z0-9-_] dropped, lowercased.
export const slugify = (str: string): string =>
	str
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/\s+/g, '-')
		.replace(/[^a-zA-Z0-9-_]/g, '')
		.toLowerCase();

/**
 * Plain-text half of the SvelteKit app's `copyToClipboard` (its `formatted`
 * branch renders markdown to styled HTML for pasting into rich editors --
 * that belongs with the chat surface, Phase 10). Uses the async Clipboard API
 * where available, otherwise the `execCommand('copy')` fallback that the
 * original keeps for insecure (non-HTTPS, non-localhost) origins.
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
	if (navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (error) {
			console.error('Async: Could not copy text: ', error);
			return false;
		}
	}
	const span = document.createElement('span');
	span.textContent = text;
	span.style.whiteSpace = 'pre';
	span.style.position = 'fixed';
	span.style.top = '0';
	span.style.left = '0';
	span.style.opacity = '0';
	document.body.appendChild(span);
	const range = document.createRange();
	range.selectNodeContents(span);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	let result = false;
	try {
		result = document.execCommand('copy');
	} catch (error) {
		console.error('Fallback: Oops, unable to copy', error);
	}
	selection?.removeAllRanges();
	document.body.removeChild(span);
	return result;
};
