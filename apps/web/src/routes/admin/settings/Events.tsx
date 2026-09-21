import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Settings, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Tip } from '@/components/common/Tip';
import { SettingSelect, SettingsSection, SettingSwitch, settingInputClass } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createEventWebhook, deleteEventWebhook, type EventWebhook, getEventWebhooks, getEvents, updateEventWebhook } from '@/lib/apis';
import { getGroupInfoById, getGroups } from '@/lib/apis/groups';
import { getUserInfoById, searchUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import {
	addFilter,
	blankForm,
	errorMessage,
	eventSummary,
	filterEvents,
	isValidPattern,
	removeFilter,
	setAllEvents,
	sortWebhooks,
	type TargetMode,
	targetsFor,
	targetsToState,
	targetSummary,
	toggleEvent,
	urlHost,
	type WebhookForm,
	webhookPayload
} from './eventWebhooks';

type Named = { id: string; name?: string; email?: string };

const Chip = ({ label, kind, onRemove, mono }: { label: string; kind?: string; onRemove: () => void; mono?: boolean }) => (
	<div className="bg-muted flex items-center gap-1 rounded-full px-2 py-1 text-xs">
		<span className={cn('max-w-36 truncate', mono && 'max-w-none font-mono break-all')}>{label}</span>
		{kind && <span className="text-muted-foreground">{kind}</span>}
		<button type="button" aria-label={`Remove ${label}`} onClick={onRemove}>
			<X className="size-3" strokeWidth={2} />
		</button>
	</div>
);

/**
 * Ports Events.svelte's dialog: create or edit one webhook -- where it posts,
 * which events it wants, and whose events it receives.
 */
function WebhookDialog({
	open,
	editing,
	catalog,
	groups,
	onClose,
	onSaved
}: {
	open: boolean;
	editing: EventWebhook | null;
	catalog: { event: string; message: string }[];
	groups: Named[];
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [form, setForm] = useState<WebhookForm>(blankForm);
	const [pattern, setPattern] = useState('');
	const [mode, setMode] = useState<TargetMode>('all');
	const [userIds, setUserIds] = useState<string[]>([]);
	const [groupIds, setGroupIds] = useState<string[]>([]);
	const [known, setKnown] = useState<{ users: Record<string, Named>; groups: Record<string, Named> }>({ users: {}, groups: {} });
	const [query, setQuery] = useState('');
	const [userResults, setUserResults] = useState<Named[]>([]);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [saving, setSaving] = useState(false);
	const searchSeq = useRef(0);

	const events = useMemo(() => catalog.map((c) => c.event), [catalog]);
	const details = useMemo(() => Object.fromEntries(catalog.map((c) => [c.event, c])), [catalog]);
	const allEvents = form.events.includes('*');
	const exact = form.events.filter((e) => e !== '*' && !e.endsWith('.*'));

	// Seed from the webhook being edited (or blank) each time the dialog opens.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setPattern('');
		setQuery('');
		setUserResults([]);
		setKnown({ users: {}, groups: {} });
		if (!editing) {
			setForm(blankForm());
			setMode('all');
			setUserIds([]);
			setGroupIds([]);
			return;
		}
		setForm({ id: editing.id, name: editing.name, url: editing.url, enabled: editing.enabled, events: editing.events?.length ? [...editing.events] : ['*'] });
		const state = targetsToState(editing.targets);
		setMode(state.mode);
		setUserIds(state.userIds);
		setGroupIds(state.groupIds);
		// Names for the chips: users by lookup, groups from the list already loaded.
		(async () => {
			const users: Record<string, Named> = {};
			const grps: Record<string, Named> = {};
			await Promise.all([
				...state.userIds.map(async (id) => {
					const u = await getUserInfoById(token, id).catch(() => null);
					if (u) users[id] = u;
				}),
				...state.groupIds.map(async (id) => {
					const g = groups.find((x) => x.id === id) ?? (await getGroupInfoById(token, id).catch(() => null));
					if (g) grps[id] = g;
				})
			]);
			if (!cancelled) setKnown({ users, groups: grps });
		})();
		return () => {
			cancelled = true;
		};
		// Seeded when the dialog opens; edits inside it are local.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, editing]);

	// Debounced user search; a stale response never overwrites a newer one.
	useEffect(() => {
		const q = query.trim();
		if (!q) {
			setUserResults([]);
			return;
		}
		const seq = ++searchSeq.current;
		const timer = setTimeout(async () => {
			const res = await searchUsers(token, query, 'name', 'asc', 1).catch(() => null);
			if (seq === searchSeq.current) setUserResults((res?.users ?? []) as Named[]);
		}, 250);
		return () => clearTimeout(timer);
	}, [query, token]);

	const groupResults = query.trim() ? groups.filter((g) => g.name?.toLowerCase().includes(query.trim().toLowerCase()) && !groupIds.includes(g.id)).slice(0, 5) : [];
	const userHits = userResults.filter((u) => !userIds.includes(u.id)).slice(0, 5);

	const addPattern = () => {
		const value = pattern.trim();
		if (!value) return;
		if (!isValidPattern(value, events)) {
			toast.error('Use a valid event name or pattern like user.*');
			return;
		}
		setForm((f) => ({ ...f, events: addFilter(f.events, value) }));
		setPattern('');
	};
	const addUser = (u: Named) => {
		setUserIds((ids) => (ids.includes(u.id) ? ids : [...ids, u.id]));
		setKnown((k) => ({ ...k, users: { ...k.users, [u.id]: u } }));
		setQuery('');
	};
	const addGroup = (g: Named) => {
		setGroupIds((ids) => (ids.includes(g.id) ? ids : [...ids, g.id]));
		setKnown((k) => ({ ...k, groups: { ...k.groups, [g.id]: g } }));
		setQuery('');
	};

	const save = async () => {
		setSaving(true);
		try {
			const payload = webhookPayload(form, targetsFor(mode, userIds, groupIds));
			if (editing) await updateEventWebhook(token, form.id, payload);
			else await createEventWebhook(token, payload);
			await onSaved();
			toast.success('Webhook saved');
			onClose();
		} catch (error) {
			toast.error(errorMessage(error, 'Failed to save webhook'));
		} finally {
			setSaving(false);
		}
	};
	const remove = async () => {
		if (!editing) return;
		try {
			await deleteEventWebhook(token, editing.id);
			await onSaved();
			toast.success('Webhook deleted');
			onClose();
		} catch (error) {
			toast.error(errorMessage(error, 'Failed to delete webhook'));
		}
	};

	return (
		<>
			<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="text-sm font-medium">{editing ? 'Edit webhook' : 'Add webhook'}</DialogTitle>
						<DialogDescription className="sr-only">Where matching events are posted, and which events and users it covers.</DialogDescription>
					</DialogHeader>
					<form
						className="flex flex-col"
						onSubmit={(e) => {
							e.preventDefault();
							e.stopPropagation();
							if (!saving) save();
						}}
					>
						<label htmlFor="event-webhook-name" className="text-muted-foreground mb-0.5 text-xs">
							Name
						</label>
						<input id="event-webhook-name" className={settingInputClass} type="text" placeholder="Identity audit" autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />

						<label htmlFor="event-webhook-url" className="text-muted-foreground mt-2 mb-0.5 text-xs">
							URL
						</label>
						<div className="flex items-center gap-2">
							<input id="event-webhook-url" className={settingInputClass} type="url" placeholder="https://example.com/events" autoComplete="off" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
							<Tip content={form.enabled ? 'Enabled' : 'Disabled'}>
								<span>
									<SettingSwitch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enabled" />
								</span>
							</Tip>
						</div>

						<div className="mt-3 flex items-center justify-between gap-3">
							<label htmlFor="event-webhook-targets" className="text-muted-foreground text-xs">
								Send events for
							</label>
							<SettingSelect id="event-webhook-targets" value={mode} onChange={(v) => setMode(v as TargetMode)}>
								<option value="all">All users and system events</option>
								<option value="system">System events only</option>
								<option value="selected">Specific users or groups</option>
							</SettingSelect>
						</div>
						<p className="text-muted-foreground mt-1 text-xs">
							{mode === 'all' && 'Receives matching events across the instance, including system/config events and events associated with any user.'}
							{mode === 'system' && 'Receives matching events that are not associated with a user.'}
							{mode === 'selected' && 'Receives matching user-associated events only when the actor, user subject, or user data matches these users or current group members. System/config events are not sent.'}
						</p>

						{mode === 'selected' && (
							<div className="mt-2">
								{(userIds.length > 0 || groupIds.length > 0) && (
									<div className="mb-2 flex flex-wrap gap-1">
										{groupIds.map((id) => (
											<Chip key={`g-${id}`} label={known.groups[id]?.name ?? id} kind="group" onRemove={() => setGroupIds((ids) => ids.filter((x) => x !== id))} />
										))}
										{userIds.map((id) => (
											<Chip key={`u-${id}`} label={known.users[id]?.name ?? id} kind="user" onRemove={() => setUserIds((ids) => ids.filter((x) => x !== id))} />
										))}
									</div>
								)}
								<div className="relative">
									<input className={settingInputClass} type="text" placeholder="Search users or groups" autoComplete="off" aria-label="Search users or groups" value={query} onChange={(e) => setQuery(e.target.value)} />
									{query.trim() && (groupResults.length > 0 || userHits.length > 0) && (
										<div className="bg-popover absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border py-1 shadow-lg">
											{groupResults.map((g) => (
												<button key={`g-${g.id}`} type="button" className="hover:bg-muted/70 flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs" onClick={() => addGroup(g)}>
													<span className="truncate">{g.name}</span>
													<span className="text-muted-foreground">Group</span>
												</button>
											))}
											{userHits.map((u) => (
												<button key={`u-${u.id}`} type="button" className="hover:bg-muted/70 flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs" onClick={() => addUser(u)}>
													<span className="truncate">
														{u.name}
														{u.email && <span className="text-muted-foreground"> ({u.email})</span>}
													</span>
													<span className="text-muted-foreground">User</span>
												</button>
											))}
										</div>
									)}
								</div>
							</div>
						)}

						<div className="mt-3 flex items-center justify-between">
							<span className="text-muted-foreground text-xs">Events</span>
							<label className="flex items-center gap-1.5 text-xs">
								<input type="checkbox" checked={allEvents} onChange={(e) => setForm({ ...form, events: setAllEvents(e.target.checked) })} />
								<span>All events</span>
							</label>
						</div>

						{!allEvents && (
							<div className="mt-2 flex flex-col gap-2">
								{form.events.length > 0 && (
									<div className="flex flex-wrap gap-1">
										{form.events.map((event) => (
											<Chip key={event} mono label={event} onRemove={() => setForm({ ...form, events: removeFilter(form.events, event) })} />
										))}
									</div>
								)}
								<div className="flex gap-2">
									<input
										className={cn(settingInputClass, 'flex-1 font-mono')}
										type="text"
										placeholder="Search or add pattern"
										aria-label="Search or add pattern"
										autoComplete="off"
										value={pattern}
										onChange={(e) => setPattern(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												addPattern();
											}
										}}
									/>
									<button type="button" className="text-xs hover:underline" onClick={addPattern}>
										Add
									</button>
								</div>
								<div className="max-h-36 overflow-y-auto pb-0.5">
									{filterEvents(events, pattern).map((event) => (
										<label key={event} className="flex items-start gap-2 py-0.5 text-xs">
											<input className="mt-0.5" type="checkbox" checked={exact.includes(event)} onChange={() => setForm({ ...form, events: toggleEvent(form.events, event) })} />
											<span className="min-w-0">
												<span className="font-mono break-all">{event}</span>
												<span className="text-muted-foreground ml-1">{details[event]?.message}</span>
											</span>
										</label>
									))}
								</div>
								<p className="text-muted-foreground text-xs">
									{/* LICENSE covers this Open WebUI wordmark.
									    Do not alter, remove, obscure, or replace it except as LICENSE permits:
									    https://docs.openwebui.com/license. */}
									Event names may change as Open WebUI evolves. Use broad patterns like user.* for integrations that should continue across new related events.
								</p>
							</div>
						)}

						<div className="flex items-center justify-between pt-4">
							<div>
								{editing && (
									<button type="button" className="text-muted-foreground hover:text-foreground px-1 py-1.5 text-sm hover:underline" onClick={() => setConfirmDelete(true)}>
										Delete
									</button>
								)}
							</div>
							<Button type="submit" disabled={saving}>
								Save
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
			<ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete webhook" confirmLabel="Delete" onConfirm={remove}>
				Are you sure you want to delete this webhook? This action cannot be undone.
			</ConfirmDialog>
		</>
	);
}

/** Ports the list half of Events.svelte: the "Events" section of General. */
export function Events() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const [dialog, setDialog] = useState<{ open: boolean; editing: EventWebhook | null }>({ open: false, editing: null });
	const data = useQuery({
		queryKey: ['admin-settings', 'event-webhooks'],
		gcTime: 0,
		staleTime: Infinity,
		refetchOnWindowFocus: false,
		queryFn: async () => {
			const [catalog, webhooks, groups] = await Promise.all([getEvents(token), getEventWebhooks(token), getGroups(token, true).catch(() => [])]);
			return {
				catalog: [...(catalog?.events ?? [])].sort((a, b) => a.event.localeCompare(b.event)),
				webhooks: sortWebhooks(webhooks ?? []),
				groups: (groups ?? []) as Named[]
			};
		}
	});
	useEffect(() => {
		if (data.isError) toast.error(errorMessage(data.error, 'Failed to load webhooks'));
	}, [data.isError, data.error]);

	const webhooks = data.data?.webhooks ?? [];
	const reload = async () => {
		await queryClient.invalidateQueries({ queryKey: ['admin-settings', 'event-webhooks'] });
	};

	// Flip at once, put it back if the server says no.
	const toggle = async (webhook: EventWebhook, enabled: boolean) => {
		const key = ['admin-settings', 'event-webhooks'];
		const previous = queryClient.getQueryData<NonNullable<typeof data.data>>(key);
		queryClient.setQueryData(key, previous && { ...previous, webhooks: previous.webhooks.map((w) => (w.id === webhook.id ? { ...w, enabled } : w)) });
		try {
			await updateEventWebhook(token, webhook.id, { enabled });
		} catch (error) {
			queryClient.setQueryData(key, previous);
			toast.error(errorMessage(error, 'Failed to update webhook'));
		}
	};

	return (
		<SettingsSection title="Events">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="text-muted-foreground text-xs">Webhooks</div>
					<p className="text-muted-foreground/70 mt-1.5 text-[0.6875rem]">Send product events as JSON to external services. Chat destinations receive readable messages.</p>
				</div>
				<Tip content="Add webhook">
					<button type="button" aria-label="Add webhook" className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 items-center justify-center rounded-lg transition-colors" onClick={() => setDialog({ open: true, editing: null })}>
						<Plus className="size-4" />
					</button>
				</Tip>
			</div>

			<div className="flex flex-col gap-1">
				{webhooks.map((webhook) => (
					<div key={webhook.id} className="flex w-full items-center gap-2" data-testid="webhook-row">
						<div className={cn('min-w-0 flex-1 truncate text-sm', !webhook.enabled && 'opacity-50')}>
							<span>{webhook.id === 'default' ? 'Default webhook' : webhook.name}</span>
							<span className="text-muted-foreground text-xs">
								{' '}
								- {urlHost(webhook.url)} - {eventSummary(webhook)} - {targetSummary(webhook)}
							</span>
						</div>
						<div className="flex items-center gap-1">
							<Tip content="Configure">
								<button type="button" aria-label={`Configure ${webhook.name}`} className="hover:bg-muted/70 rounded-lg p-1 transition" onClick={() => setDialog({ open: true, editing: webhook })}>
									<Settings className="size-4" />
								</button>
							</Tip>
							<Tip content={webhook.enabled ? 'Enabled' : 'Disabled'}>
								<span>
									<SettingSwitch checked={webhook.enabled} onChange={(v) => toggle(webhook, v)} label={`Enable ${webhook.name}`} />
								</span>
							</Tip>
						</div>
					</div>
				))}
			</div>
			{data.data && webhooks.length === 0 && <p className="text-muted-foreground text-xs">No event webhooks configured.</p>}

			<WebhookDialog open={dialog.open} editing={dialog.editing} catalog={data.data?.catalog ?? []} groups={data.data?.groups ?? []} onClose={() => setDialog((d) => ({ ...d, open: false }))} onSaved={reload} />
		</SettingsSection>
	);
}
