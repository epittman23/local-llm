import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
	type NotificationTarget,
	createNotificationTarget,
	deleteNotificationTarget,
	getNotificationEvents,
	getNotificationTargets,
	setDefaultNotificationTarget,
	testNotificationTarget,
	updateNotificationTarget
} from '@/lib/apis/notifications';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { SettingRow, SettingSwitch, SettingsForm, SettingsSection } from '../controls';

const DEFAULT_EVENTS = [
	{ event: 'chat.finished', label: 'Chat finished', description: 'A chat run finished successfully.' },
	{ event: 'chat.failed', label: 'Chat failed', description: 'A chat run failed.' }
];
type Form = { id: string; url: string; enabled: boolean; events: string[]; delivery: 'away' | 'always' };

/**
 * Ports Settings/Notifications.svelte: browser notifications (asking the
 * browser's permission first) and the notification sound, both saved at
 * once, and -- where the server enables user webhooks and the user may use
 * them -- webhook targets: which events, only when away or always, default,
 * test, edit (a blank URL keeps the current one), remove.
 */
export default function Notifications() {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const { settings, update } = useUserSettings();
	const canWebhooks = Boolean((config?.features as Record<string, unknown> | undefined)?.enable_user_webhooks) && (user?.role === 'admin' || Boolean((user?.permissions as { features?: { webhooks?: boolean } } | undefined)?.features?.webhooks));
	const events = useQuery({ queryKey: ['notification-events'], enabled: canWebhooks, queryFn: async () => (await getNotificationEvents(token).catch(() => null)) ?? DEFAULT_EVENTS });
	const targets = useQuery({ queryKey: ['notification-targets'], enabled: canWebhooks, queryFn: async () => ((await getNotificationTargets(token)) as { targets?: NotificationTarget[] })?.targets ?? [] });
	const [form, setForm] = useState<Form | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const s = (settings ?? {}) as { notificationEnabled?: boolean; notificationSound?: boolean };
	const eventList = events.data?.length ? events.data : DEFAULT_EVENTS;

	const toggleBrowser = async (on: boolean) => {
		if (on) {
			const permission = 'Notification' in window ? await Notification.requestPermission() : 'denied';
			if (permission !== 'granted') {
				toast.error('Response notifications cannot be activated as the website permissions have been denied. Please visit your browser settings to grant the necessary access.');
				return;
			}
		}
		await update({ notificationEnabled: on }).catch((e) => toast.error(`${e?.message ?? e}`));
	};

	const act = async (fn: () => Promise<unknown>, done?: string) => {
		try {
			await fn();
			if (done) toast.success(done);
		} catch (e) {
			toast.error(`${e}`);
		}
		void targets.refetch();
	};

	return (
		<SettingsForm title="Notifications" footer={false}>
			<SettingsSection first>
				<SettingRow label="Browser Notifications" description="Allow browser notifications for completed responses.">
					{(id) => <SettingSwitch labelledBy={id} checked={Boolean(s.notificationEnabled)} onChange={(v) => void toggleBrowser(v)} />}
				</SettingRow>
				<SettingRow label="Notification Sound">{(id) => <SettingSwitch labelledBy={id} checked={s.notificationSound ?? true} onChange={(v) => void update({ notificationSound: v })} />}</SettingRow>
			</SettingsSection>
			{canWebhooks && (
				<SettingsSection title="Notification Targets">
					<div className="flex justify-end">
						<Button
							type="button"
							size="sm"
							variant="outline"
							aria-label="Add Notification Target"
							onClick={() => {
								setEditingId(null);
								setForm({ id: '', url: '', enabled: true, events: [], delivery: 'away' });
							}}
						>
							<Plus className="size-3.5" /> Add
						</Button>
					</div>
					{targets.isLoading ? (
						<p className="text-muted-foreground text-xs">Loading...</p>
					) : !targets.data?.length ? (
						<p className="text-muted-foreground text-xs">No notification targets configured.</p>
					) : (
						<ul className="flex flex-col gap-2" aria-label="Notification targets">
							{targets.data.map((t) => (
								<li key={t.id} className="rounded-xl border p-2.5 text-xs">
									<div className="flex items-center gap-2">
										<span className="font-medium">{t.id}</span>
										<span className="text-muted-foreground">Webhook</span>
										{t.is_default && <span className="rounded bg-blue-500/10 px-1 text-blue-600">Default</span>}
										<Switch className="ml-auto" aria-label={`Enabled: ${t.id}`} checked={t.enabled} onCheckedChange={(v) => void act(() => updateNotificationTarget(token, t.id, { enabled: v }))} />
									</div>
									<div className="text-muted-foreground mt-1 truncate">{t.config?.url_masked ?? t.config?.url}</div>
									<div className="text-muted-foreground">
										{t.events.map((e) => eventList.find((x) => x.event === e)?.label ?? e).join(', ') || 'No chat alerts'} · {t.delivery === 'away' ? 'Only when away' : 'Always'}
									</div>
									<div className="mt-1.5 flex gap-2">
										<button type="button" className="underline" onClick={() => void act(() => testNotificationTarget(token, t.id), 'Test notification sent.')}>
											Send Test
										</button>
										{!t.is_default && (
											<button type="button" className="underline" onClick={() => void act(() => setDefaultNotificationTarget(token, t.id))}>
												Make Default
											</button>
										)}
										<button
											type="button"
											className="underline"
											onClick={() => {
												setEditingId(t.id);
												setForm({ id: t.id, url: '', enabled: t.enabled, events: [...t.events], delivery: t.delivery });
											}}
										>
											Edit
										</button>
										<button type="button" className="text-destructive underline" onClick={() => void act(() => deleteNotificationTarget(token, t.id))}>
											Remove
										</button>
									</div>
								</li>
							))}
						</ul>
					)}
				</SettingsSection>
			)}
			<Dialog open={Boolean(form)} onOpenChange={(o) => !o && setForm(null)}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>{editingId ? 'Edit' : 'Add Notification Target'}</DialogTitle>
						<DialogDescription className="sr-only">A webhook that receives chat notifications</DialogDescription>
					</DialogHeader>
					{form && (
						<form
							className="flex flex-col gap-3 text-sm"
							onSubmit={async (e) => {
								e.preventDefault();
								setSaving(true);
								const id = form.id.trim();
								const payload: Partial<NotificationTarget> = { ...(id ? { id } : {}), type: 'webhook', enabled: form.enabled, events: form.events, delivery: form.delivery, ...(form.url.trim() ? { config: { url: form.url.trim() } } : {}) };
								try {
									if (editingId) await updateNotificationTarget(token, editingId, payload);
									else await createNotificationTarget(token, payload);
									toast.success('Settings saved successfully!');
									setForm(null);
								} catch (err) {
									toast.error(`${err}`);
								}
								setSaving(false);
								void targets.refetch();
							}}
						>
							<label className="flex flex-col gap-1 text-xs">
								Target ID for notify
								<Input value={form.id} disabled={Boolean(editingId)} placeholder="Target ID" onChange={(e) => setForm({ ...form, id: e.target.value })} />
							</label>
							<label className="flex flex-col gap-1 text-xs">
								Webhook
								<Input type="url" value={form.url} required={!editingId} placeholder={editingId ? 'Keep current webhook URL' : 'https://'} onChange={(e) => setForm({ ...form, url: e.target.value })} />
							</label>
							<fieldset className="flex flex-col gap-1 text-xs">
								<legend className="mb-1">Automatic Events</legend>
								{eventList.map((ev) => (
									<label key={ev.event} className="flex items-center gap-2">
										<input type="checkbox" checked={form.events.includes(ev.event)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev.event] : form.events.filter((x) => x !== ev.event) })} />
										{ev.label}
									</label>
								))}
							</fieldset>
							<label className="flex items-center justify-between text-xs">
								Automatic Delivery
								<select className="border-input h-8 rounded-md border bg-transparent px-2" value={form.delivery} onChange={(e) => setForm({ ...form, delivery: e.target.value as Form['delivery'] })}>
									<option value="away">Only when away</option>
									<option value="always">Always</option>
								</select>
							</label>
							<p className="text-muted-foreground text-[0.6875rem]">The notify tool always sends to an enabled target, regardless of automatic event settings.</p>
							<DialogFooter>
								<Button type="button" variant="outline" onClick={() => setForm(null)}>
									Cancel
								</Button>
								<Button type="submit" disabled={saving}>
									{saving ? 'Saving...' : 'Save'}
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</SettingsForm>
	);
}
