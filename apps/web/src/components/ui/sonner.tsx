import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { type ExternalToast, Toaster as Sonner, type ToasterProps, toast } from 'sonner';
import { sessionEndReason } from '@/lib/auth/session';
import { useConnectionStore } from '@/lib/socket/connectionStore';

// The shadcn template reads `next-themes`, which needs its own
// ThemeProvider and has no idea about this app's theme mechanism (a `dark`/
// `light` class on <html>, set by Base.astro's anti-FOUC script from
// localStorage.theme). Read that class directly instead, so a toast always
// matches what the page is actually showing, including an explicit choice
// that disagrees with the OS setting.
const subscribeToThemeClass = (notify: () => void) => {
	const observer = new MutationObserver(notify);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
	return () => observer.disconnect();
};
const readTheme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

/** Toasts sit bottom right on a wide screen and at the top on a phone (FBK-2). */
export const WIDE_QUERY = '(min-width: 768px)';
const subscribeToWidth = (notify: () => void) => {
	const query = window.matchMedia(WIDE_QUERY);
	query.addEventListener('change', notify);
	return () => query.removeEventListener('change', notify);
};
const readWide = () => window.matchMedia(WIDE_QUERY).matches;

/** Sonner's own distance from the viewport's edge on a wide screen. */
const EDGE_OFFSET = 24;
/** The gap kept between a toast and the message box under it. */
const KEEP_CLEAR_GAP = 8;
/** On a phone, toasts start below the connection banner while it shows. */
const BELOW_BANNER_OFFSET = 56;

/**
 * The bottom offset that keeps a toast off the message box (FBK-2): the
 * distance from the viewport's bottom to the top edge of the highest
 * composite field whose top is in the lower half of the viewport (the chat's
 * message box, not a search box near the top), plus a gap. Null when there
 * is none, so the toast keeps Sonner's own offset.
 */
export function keepClearOffset(): number | null {
	const height = window.innerHeight;
	let offset: number | null = null;
	for (const field of document.querySelectorAll('[data-composite-field]')) {
		const rect = field.getBoundingClientRect();
		if (rect.height === 0 || rect.top < height / 2 || rect.top > height) continue;
		const clear = Math.ceil(height - rect.top + KEEP_CLEAR_GAP);
		if (offset === null || clear > offset) offset = clear;
	}
	return offset === null ? null : Math.max(offset, EDGE_OFFSET);
}

/** keepClearOffset, kept current while fields appear, move and resize. */
function useKeepClearOffset(enabled: boolean) {
	const [offset, setOffset] = useState<number | null>(null);
	useEffect(() => {
		if (!enabled) {
			setOffset(null);
			return;
		}
		let frame = 0;
		const observed = new Set<Element>();
		const measure = () => {
			frame = 0;
			setOffset(keepClearOffset());
			// Watch the fields themselves too: a message box grows as it is typed in.
			for (const field of document.querySelectorAll('[data-composite-field]')) {
				if (observed.has(field)) continue;
				observed.add(field);
				resize.observe(field);
			}
		};
		// Coalesced into one measurement per frame: a streaming answer changes
		// the document many times a second.
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		const resize = new ResizeObserver(schedule);
		const mutations = new MutationObserver(schedule);
		mutations.observe(document.body, { childList: true, subtree: true });
		window.addEventListener('resize', schedule);
		measure();
		return () => {
			if (frame) cancelAnimationFrame(frame);
			mutations.disconnect();
			resize.disconnect();
			window.removeEventListener('resize', schedule);
		};
	}, [enabled]);
	return offset;
}

/** A short, stable id for a message, so the same failure raised again updates one toast. */
export function messageId(message: string) {
	let hash = 0;
	for (let i = 0; i < message.length; i++) hash = (Math.imul(hash, 31) + message.charCodeAt(i)) | 0;
	return `msg-${(hash >>> 0).toString(36)}`;
}

type ToastFn = (message: Parameters<typeof toast.error>[0], data?: ExternalToast) => string | number;

/**
 * A failure or a warning stays until it is dismissed, while a confirmation
 * leaves after 4 seconds (FBK-2). Set here, once, for every `toast.error`
 * and `toast.warning` in the app instead of at each call: no time limit, and
 * an id derived from the text, so the same failure raised again (a poll,
 * every request while offline) updates the toast already showing instead of
 * stacking another. A caller's own `duration` or `id` still wins.
 *
 * Once the session has run out, the failures of requests it still made are
 * not shown: they all fail for that one reason, which the sign-in page
 * explains in place (FBK-1), so the person sees one message, not a pile.
 */
const persistent =
	(show: ToastFn): ToastFn =>
	(message, data) => {
		const id = data?.id ?? (typeof message === 'string' ? messageId(message) : undefined);
		if (sessionEndReason() === 'expired') return id ?? '';
		return show(message, { duration: Number.POSITIVE_INFINITY, ...(id === undefined ? {} : { id }), ...data });
	};
const patched = toast as typeof toast & { persistentFailures?: true };
if (!patched.persistentFailures) {
	patched.persistentFailures = true;
	toast.error = persistent(toast.error);
	toast.warning = persistent(toast.warning);
}

const Toaster = ({ ...props }: ToasterProps) => {
	const theme = useSyncExternalStore(subscribeToThemeClass, readTheme, () => 'light');
	const wide = useSyncExternalStore(subscribeToWidth, readWide, () => true);
	const keepClear = useKeepClearOffset(wide);
	const bannerShown = useConnectionStore((state) => state.lost);

	return (
		<Sonner
			theme={theme as ToasterProps['theme']}
			className="toaster group"
			position={wide ? 'bottom-right' : 'top-center'}
			offset={keepClear === null ? undefined : { bottom: keepClear, right: EDGE_OFFSET }}
			mobileOffset={bannerShown ? { top: BELOW_BANNER_OFFSET } : undefined}
			closeButton
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
				loading: <Loader2Icon className="size-4 animate-spin" />
			}}
			style={
				{
					// A floating layer: --surface-2 with an edge (OVL-2, COL-5).
					'--normal-bg': 'var(--surface-2)',
					'--normal-text': 'var(--foreground)',
					'--normal-border': 'var(--border-divider)',
					'--border-radius': 'var(--radius)'
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast: 'cn-toast',
					// Sonner draws a 20 px close button; its hit area reaches 26 px,
					// and 46 px on a touch screen (LAY-3).
					closeButton: "after:absolute after:-inset-1 after:content-[''] pointer-coarse:after:-inset-3.5"
				}
			}}
			{...props}
		/>
	);
};

export { Toaster };
