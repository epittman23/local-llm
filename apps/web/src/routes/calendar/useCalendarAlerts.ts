import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useSocket } from '@/lib/socket/SocketProvider';
import { isLastActiveTab } from '@/lib/utils/lastActiveTab';
import { routePaths } from '@/routes/routePaths';

/** The `data` of a `calendar:alert` event (utils/automations.py's calendar alert check). */
type CalendarAlert = {
	event_id: string;
	title: string;
	description: string;
	start_at: number;
	minutes_until: number;
	calendar_id: string;
	location: string;
};

type SocketEvent = { data?: { type?: string; data?: CalendarAlert } };

export const calendarAlertText = (minutes: number) =>
	minutes <= 0 ? 'Starting now' : minutes === 1 ? 'Starting in 1 minute' : `Starting in ${minutes} minutes`;

/**
 * Ports d863707:apps/openwebui/src/routes/+layout.svelte's `calendar:alert`
 * branch: an event reminder arrives on the `events` channel, wherever the
 * viewer is, as a toast that opens the calendar, and as a browser
 * notification if they turned those on in Settings and granted the
 * permission. Every open tab shows the toast, but only the last active one
 * sends the notification, as the original did (`$isLastActiveTab`; #621); its
 * tag is the event's, in case two tabs both think they are. Mounted once, in
 * AppShell, beside the channel events hook that tracks the active tab.
 */
export function useCalendarAlerts() {
	const { socket } = useSocket();
	const navigate = useNavigate();
	const { settings } = useUserSettings();
	const notify = Boolean((settings as Record<string, unknown> | null)?.notificationEnabled);

	useEffect(() => {
		if (!socket) return;
		const handler = (event: SocketEvent) => {
			const alert = event.data?.type === 'calendar:alert' ? event.data.data : undefined;
			if (!alert) return;
			const body = calendarAlertText(alert.minutes_until);
			toast(alert.title, {
				description: body,
				duration: 30000,
				action: { label: 'Open', onClick: () => navigate(routePaths.calendar) }
			});
			if (notify && isLastActiveTab() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
				new Notification(alert.title, { body, tag: `calendar:${alert.event_id}` });
			}
		};
		socket.on('events', handler);
		return () => {
			socket.off('events', handler);
		};
	}, [socket, navigate, notify]);
}
