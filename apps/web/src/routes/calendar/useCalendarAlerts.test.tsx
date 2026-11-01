import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calendarAlertText, useCalendarAlerts } from './useCalendarAlerts';

const { socket, navigate, toast, settings } = vi.hoisted(() => ({
	socket: { on: vi.fn(), off: vi.fn() },
	navigate: vi.fn(),
	toast: vi.fn(),
	settings: { current: {} as Record<string, unknown> }
}));
vi.mock('@/lib/socket/SocketProvider', () => ({ useSocket: () => ({ socket, connected: true }) }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: settings.current }) }));
vi.mock('react-router', () => ({ useNavigate: () => navigate }));
vi.mock('sonner', () => ({ toast }));

// What utils/automations.py's calendar alert check emits on the `events` channel.
const alert = (minutes_until: number) => ({
	data: {
		type: 'calendar:alert',
		data: {
			event_id: 'e1',
			title: 'Standup',
			description: '',
			start_at: 1_700_000_000_000_000_000,
			minutes_until,
			calendar_id: 'personal',
			location: ''
		}
	}
});

/** The handler the hook registered for `events`. */
const handler = () => {
	const call = socket.on.mock.calls.find(([name]) => name === 'events');
	if (!call) throw new Error('no events listener');
	return call[1] as (event: unknown) => void;
};

let NotificationMock: ReturnType<typeof vi.fn> & { permission: string };

describe('calendarAlertText', () => {
	it('says how soon the event starts', () => {
		expect(calendarAlertText(0)).toBe('Starting now');
		expect(calendarAlertText(1)).toBe('Starting in 1 minute');
		expect(calendarAlertText(10)).toBe('Starting in 10 minutes');
	});
});

describe('useCalendarAlerts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		settings.current = {};
		NotificationMock = Object.assign(vi.fn(), { permission: 'granted' });
		vi.stubGlobal('Notification', NotificationMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shows a calendar alert as a toast that opens the calendar', () => {
		renderHook(() => useCalendarAlerts());
		handler()(alert(5));
		expect(toast).toHaveBeenCalledTimes(1);
		const [title, options] = toast.mock.calls[0];
		expect(title).toBe('Standup');
		expect(options).toMatchObject({ description: 'Starting in 5 minutes', duration: 30000 });
		options.action.onClick();
		expect(navigate).toHaveBeenCalledWith('/calendar');
	});

	it('also sends a browser notification when they are on and permitted, one per event across tabs', () => {
		settings.current = { notificationEnabled: true };
		renderHook(() => useCalendarAlerts());
		handler()(alert(0));
		expect(NotificationMock).toHaveBeenCalledWith('Standup', { body: 'Starting now', tag: 'calendar:e1' });
	});

	it('sends no browser notification when they are off in Settings', () => {
		renderHook(() => useCalendarAlerts());
		handler()(alert(1));
		expect(toast).toHaveBeenCalledTimes(1);
		expect(NotificationMock).not.toHaveBeenCalled();
	});

	it('sends no browser notification without the permission', () => {
		settings.current = { notificationEnabled: true };
		NotificationMock.permission = 'denied';
		renderHook(() => useCalendarAlerts());
		handler()(alert(1));
		expect(toast).toHaveBeenCalledTimes(1);
		expect(NotificationMock).not.toHaveBeenCalled();
	});

	it('ignores the chat traffic that shares the events channel', () => {
		settings.current = { notificationEnabled: true };
		renderHook(() => useCalendarAlerts());
		handler()({ chat_id: 'c1', message_id: 'm1', data: { type: 'chat:completion', data: { content: 'hi' } } });
		handler()({ data: { type: 'calendar:alert' } });
		expect(toast).not.toHaveBeenCalled();
		expect(NotificationMock).not.toHaveBeenCalled();
	});

	it('stops listening on unmount', () => {
		const { unmount } = renderHook(() => useCalendarAlerts());
		const registered = handler();
		unmount();
		expect(socket.off).toHaveBeenCalledWith('events', registered);
	});
});
