import { X } from 'lucide-react';
import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore
} from 'react';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

/** The narrowest the content beside a side panel may become: 24 rem (CNV-2). */
export const CONTENT_MIN = 384;
/** One arrow press on the separator, and one with Shift. */
const STEP = 16;
const BIG_STEP = 64;

const MD_UP = '(min-width: 768px)';

/** Whether the screen is `md` or wider. Without `matchMedia` (a test's DOM) it counts as wide. */
export function useMdUp(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const mq = window.matchMedia?.(MD_UP);
			mq?.addEventListener('change', onChange);
			return () => mq?.removeEventListener('change', onChange);
		},
		() => window.matchMedia?.(MD_UP).matches ?? true,
		() => true
	);
}

/**
 * Column or sheet, by the space the panel shares with the content (CNV-2,
 * LAY-4): a column only when that space holds the panel's minimum and 24 rem
 * of content beside it, and never below `md`.
 */
export function panelMode(space: number, minWidth: number, isMd: boolean): 'column' | 'sheet' {
	return isMd && space >= minWidth + CONTENT_MIN ? 'column' : 'sheet';
}

/** The widest the column may be in `space`: what leaves the content its 24 rem, and never under its minimum. */
export function maxWidth(minWidth: number, space: number): number {
	return Math.max(minWidth, space - CONTENT_MIN);
}

/** A width kept between the panel's minimum and the most `space` allows, in whole pixels. */
export function clampWidth(width: number, minWidth: number, space: number): number {
	return Math.round(Math.min(maxWidth(minWidth, space), Math.max(minWidth, width)));
}

/**
 * What a key on the separator does to the width. The handle is at the panel's
 * left edge, so ArrowLeft widens it and ArrowRight narrows it; Home is the
 * widest, End the narrowest. Null for any other key.
 */
export function stepFor(key: string, shift: boolean): number | 'max' | 'min' | null {
	const step = shift ? BIG_STEP : STEP;
	if (key === 'ArrowLeft') return step;
	if (key === 'ArrowRight') return -step;
	if (key === 'Home') return 'max';
	if (key === 'End') return 'min';
	return null;
}

function readWidth(key: string, fallback: number): number {
	try {
		const n = Number(localStorage.getItem(key));
		return Number.isFinite(n) && n > 0 ? n : fallback;
	} catch {
		return fallback;
	}
}

/** What focus goes back to: the element that had it, or a menu's trigger when a menu item opened the panel (NAV-4). */
function openerOf(active: Element | null): HTMLElement | null {
	const menu = active?.closest('[role="menu"][id]');
	const trigger = menu && document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`);
	const target = trigger ?? active;
	return target instanceof HTMLElement && target !== document.body ? target : null;
}

/**
 * The right-hand panel beside a page's content (CNV-2, LAY-4, NAV-4): a
 * column with a resize handle where there is room, otherwise the shared
 * `Sheet`, full screen, over the content. Never squeezes the content below
 * 24 rem. Opening moves focus to its heading; closing returns it to what
 * opened it. In a column, Escape closes it only while focus is inside it and
 * nothing in it (a menu, a list) took the key first.
 *
 * The space is measured on the element the panel is rendered in: the row it
 * shares with the content, so it does not change when the panel opens.
 */
export function SidePanel({
	open,
	onClose,
	title,
	storageKey,
	defaultWidth,
	minWidth,
	actions,
	children
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	/** Where the column's width is kept in `localStorage`. */
	storageKey: string;
	/** In px. */
	defaultWidth: number;
	/** In px. */
	minWidth: number;
	/** Header buttons, shown before Close. */
	actions?: ReactNode;
	children: ReactNode;
}) {
	const isMd = useMdUp();
	const anchor = useRef<HTMLSpanElement>(null);
	// Unmeasured (no ResizeObserver, or a row with no box: hidden, or a test's
	// DOM, which lays nothing out) counts as room for a column, so a hidden page
	// never puts a sheet over the one shown.
	const [space, setSpace] = useState(Number.POSITIVE_INFINITY);
	useLayoutEffect(() => {
		const row = anchor.current?.parentElement;
		if (!row || typeof ResizeObserver === 'undefined') return;
		const measure = () => setSpace(row.clientWidth || Number.POSITIVE_INFINITY);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		return () => observer.disconnect();
	}, []);
	const mode = panelMode(space, minWidth, isMd);

	const [stored, setStored] = useState(() => readWidth(storageKey, defaultWidth));
	const width = clampWidth(stored, minWidth, space);
	const setWidth = (w: number) => {
		const next = clampWidth(w, minWidth, space);
		setStored(next);
		try {
			localStorage.setItem(storageKey, String(next));
		} catch {
			// Not kept (a private window, blocked storage): the width still applies now.
		}
	};

	const panel = useRef<HTMLElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const column = open && mode === 'column';

	// Focus: to the heading on opening, back to the opener on closing (NAV-4).
	// A sheet does both itself (SheetContent).
	useLayoutEffect(() => {
		if (!column) return;
		const opener = openerOf(document.activeElement);
		heading.current?.focus();
		const el = panel.current;
		return () => {
			const active = document.activeElement;
			const inside = !active || active === document.body || el?.contains(active);
			if (inside && opener?.isConnected) opener.focus({ preventScroll: true });
		};
	}, [column]);

	// NAV-4: Escape closes a column only from inside it, and only when nothing
	// inside it took the key. A native listener on the panel, so an Escape in a
	// layer portalled out of it (a select's list) is not seen here.
	useEffect(() => {
		const el = panel.current;
		if (!column || !el) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (
				event.key === 'Escape' &&
				!event.defaultPrevented &&
				event.target instanceof Node &&
				el.contains(event.target)
			)
				onCloseRef.current();
		};
		el.addEventListener('keydown', onKey);
		return () => el.removeEventListener('keydown', onKey);
	}, [column]);

	const drag = useRef<{ x: number; width: number } | null>(null);
	const separator = {
		onKeyDown(e: KeyboardEvent<HTMLHRElement>) {
			const step = stepFor(e.key, e.shiftKey);
			if (step === null) return;
			e.preventDefault();
			setWidth(step === 'max' ? maxWidth(minWidth, space) : step === 'min' ? minWidth : width + step);
		},
		onPointerDown(e: PointerEvent<HTMLHRElement>) {
			e.currentTarget.setPointerCapture?.(e.pointerId);
			drag.current = { x: e.clientX, width };
		},
		onPointerMove(e: PointerEvent<HTMLHRElement>) {
			if (drag.current) setWidth(drag.current.width + drag.current.x - e.clientX);
		},
		onPointerUp() {
			drag.current = null;
		},
		// The browser took the pointer (a touch turned into a scroll, a system gesture): the drag ends too.
		onPointerCancel() {
			drag.current = null;
		},
		onLostPointerCapture() {
			drag.current = null;
		}
	};

	const lower = title.toLowerCase();
	const header = (titleEl: ReactNode) => (
		<div className="flex items-center gap-1 py-2 ps-4 pe-2">
			{titleEl}
			{actions}
			<Tip content="Close">
				<Button type="button" aria-label={`Close ${lower}`} variant="ghost" size="icon-sm" onClick={onClose}>
					<X />
				</Button>
			</Tip>
		</div>
	);
	const headingClass = 'text-body font-title min-w-0 flex-1 truncate';

	return (
		<>
			<span ref={anchor} hidden />
			{column && (
				<aside
					ref={panel}
					aria-label={title}
					style={{ width }}
					className="relative flex h-full min-h-0 shrink-0 flex-col border-l"
				>
					<hr
						aria-orientation="vertical"
						aria-label={`Resize ${lower}`}
						aria-valuenow={width}
						aria-valuemin={minWidth}
						aria-valuemax={Number.isFinite(space) ? maxWidth(minWidth, space) : undefined}
						tabIndex={0}
						data-testid="side-panel-separator"
						className="m-0 h-auto border-0 after:bg-border-control absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1.5 after:w-px after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100 motion-reduce:after:transition-none"
						{...separator}
					/>
					{header(
						<h2 ref={heading} tabIndex={-1} className={headingClass}>
							{title}
						</h2>
					)}
					<div className="flex min-h-0 flex-1 flex-col">{children}</div>
				</aside>
			)}
			{mode === 'sheet' && (
				<Sheet open={open} onOpenChange={(next) => !next && onClose()}>
					<SheetContent
						side="right"
						showCloseButton={false}
						aria-describedby={undefined}
						className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
						onOpenAutoFocus={(e) => {
							e.preventDefault();
							heading.current?.focus();
						}}
					>
						{header(
							<SheetTitle ref={heading} tabIndex={-1} className={headingClass}>
								{title}
							</SheetTitle>
						)}
						<div className="flex min-h-0 flex-1 flex-col">{children}</div>
					</SheetContent>
				</Sheet>
			)}
		</>
	);
}
