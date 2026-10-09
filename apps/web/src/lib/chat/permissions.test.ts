import { describe, expect, it } from 'vitest';
import { canChat } from './permissions';

const user = (chat: Record<string, boolean> = {}, role = 'user') =>
	({ id: 'u', name: 'U', email: '', role, permissions: { chat } }) as any;

describe('canChat', () => {
	it('uses each action’s own default', () => {
		expect(canChat(user(), 'edit')).toBe(true);
		expect(canChat(user(), 'delete_message')).toBe(true);
		expect(canChat(user(), 'delete_user_message')).toBe(false);
		expect(canChat(user(), 'temporary')).toBe(false);
	});
	it('follows an explicit permission, and lets admins do everything', () => {
		expect(canChat(user({ delete_message: true }), 'delete_user_message')).toBe(true);
		expect(canChat(user({ edit: false }), 'edit')).toBe(false);
		expect(canChat(user({ edit: false }, 'admin'), 'edit')).toBe(true);
		expect(canChat(null, 'edit')).toBe(false);
	});
});
