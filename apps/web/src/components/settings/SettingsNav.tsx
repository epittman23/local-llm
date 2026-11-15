import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AdminTabIcon } from './AdminTabIcon';
import { adminTabSegment, type SettingsTab, sectionOf, startsGroup } from './settingsTabs';

/** The DOM id of a tab's button; `aria-labelledby` of the panel while it is open. */
export const settingsTabId = (id: string) => `settings-tab-${id.replace(':', '-')}`;
export const SETTINGS_PANEL_ID = 'settings-panel';

/**
 * The Settings tab list (#999, #1000, NAV-2, NAV-5): one vertical tablist in
 * two labelled halves, "Your settings" and "Server", each with its smaller
 * group captions. Roving focus: Tab enters on the open tab and leaves for the
 * panel; Up, Down, Home and End move between tabs, and Enter or Space opens
 * one (manual activation, since a tab loads its code when opened and may ask
 * "Discard changes?" first). The open tab scrolls into view when it changes.
 * Captions are hidden from assistive technology; a tab's name carries its
 * half where the name would otherwise repeat ("Server: General"), and the
 * visible text drops that prefix under its heading.
 * Kept apart from the modal so `/admin/settings/<tab>` pages can reuse it (#932).
 */
export function SettingsNav({
	tabs,
	selected,
	onSelect,
	className
}: {
	tabs: SettingsTab[];
	selected: string | null;
	onSelect: (id: string) => void;
	className?: string;
}) {
	const [focusId, setFocusId] = useState(selected);
	const buttons = useRef(new Map<string, HTMLButtonElement>());

	useEffect(() => {
		setFocusId(selected);
		if (selected) buttons.current.get(selected)?.scrollIntoView?.({ block: 'nearest' });
	}, [selected]);

	const rover = focusId && tabs.some((t) => t.id === focusId) ? focusId : (tabs[0]?.id ?? null);
	const onKeyDown = (event: KeyboardEvent) => {
		const ids = tabs.map((t) => t.id);
		const at = ids.indexOf(rover ?? '');
		const next =
			event.key === 'ArrowDown'
				? ids[Math.min(ids.length - 1, at + 1)]
				: event.key === 'ArrowUp'
					? ids[Math.max(0, at - 1)]
					: event.key === 'Home'
						? ids[0]
						: event.key === 'End'
							? ids[ids.length - 1]
							: null;
		if (!next) return;
		event.preventDefault();
		setFocusId(next);
		const button = buttons.current.get(next);
		button?.focus();
		button?.scrollIntoView?.({ block: 'nearest' });
	};

	return (
		<div
			role="tablist"
			aria-orientation="vertical"
			aria-label="Settings"
			onKeyDown={onKeyDown}
			className={cn('flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 pb-3', className)}
		>
			{tabs.map((tab, index) => {
				const section = sectionOf(tab.id);
				const startsSection = index === 0 || sectionOf(tabs[index - 1].id) !== section;
				const prefix = `${section}: `;
				const visible = tab.title.startsWith(prefix) ? tab.title.slice(prefix.length) : tab.title;
				return (
					<div key={tab.id} className="contents">
						{startsSection && (
							<div
								aria-hidden
								className={cn(
									'text-foreground-strong font-strong px-2 pb-1',
									index === 0 ? 'pt-1' : 'mt-3 border-t pt-4'
								)}
							>
								{section}
							</div>
						)}
						{startsGroup(tabs, index) && (
							<div
								aria-hidden
								className={cn('text-foreground-muted px-2 pb-0.5 text-caption', !startsSection && 'pt-2')}
							>
								{tab.group}
							</div>
						)}
						<Button
							ref={(el) => {
								if (el) buttons.current.set(tab.id, el);
								else buttons.current.delete(tab.id);
							}}
							id={settingsTabId(tab.id)}
							variant={selected === tab.id ? 'secondary' : 'ghost'}
							className={cn('relative w-full shrink justify-start', selected === tab.id && 'text-foreground-strong')}
							type="button"
							role="tab"
							tabIndex={tab.id === rover ? 0 : -1}
							aria-selected={selected === tab.id}
							aria-controls={selected === tab.id ? SETTINGS_PANEL_ID : undefined}
							onFocus={() => setFocusId(tab.id)}
							onClick={() => onSelect(tab.id)}
						>
							{selected === tab.id && (
								<span aria-hidden className="bg-brand absolute inset-y-1.5 left-0 w-0.5 rounded-full" />
							)}
							<AdminTabIcon id={adminTabSegment(tab.id)} />
							<span className="truncate">
								{visible !== tab.title && <span className="sr-only">{prefix}</span>}
								{visible}
							</span>
						</Button>
					</div>
				);
			})}
		</div>
	);
}
