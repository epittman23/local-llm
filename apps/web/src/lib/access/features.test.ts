import { describe, expect, it } from 'vitest';
import { canUseFeature } from './features';

const user = (role: string, features: Record<string, boolean> = {}) => ({
	id: 'u',
	email: '',
	name: '',
	role,
	profile_image_url: '',
	permissions: { features }
});
const config = (features: Record<string, boolean>) => ({ name: 'x', version: '1', features });

describe('canUseFeature', () => {
	it('needs a session and a config', () => {
		expect(canUseFeature('notes', null, config({ enable_notes: true }))).toBe(false);
		expect(canUseFeature('notes', user('admin'), null)).toBe(false);
	});
	it('the backend switch wins over everything, even for an admin', () => {
		expect(canUseFeature('calendar', user('admin'), config({ enable_calendar: false }))).toBe(false);
		expect(canUseFeature('calendar', user('admin'), config({ enable_calendar: true }))).toBe(true);
	});
	it('notes and channels are allowed unless denied; calendar and automations need the permission', () => {
		expect(canUseFeature('notes', user('user'), config({ enable_notes: true }))).toBe(true);
		expect(canUseFeature('notes', user('user', { notes: false }), config({ enable_notes: true }))).toBe(false);
		expect(canUseFeature('calendar', user('user'), config({ enable_calendar: true }))).toBe(false);
		expect(
			canUseFeature('automations', user('user', { automations: true }), config({ enable_automations: true }))
		).toBe(true);
		expect(canUseFeature('channels', user('user'), config({ enable_channels: true }))).toBe(true);
		expect(canUseFeature('channels', user('user', { channels: false }), config({ enable_channels: true }))).toBe(false);
	});
	it('the playground is for admins only', () => {
		expect(canUseFeature('playground', user('user'), config({}))).toBe(false);
		expect(canUseFeature('playground', user('admin'), config({}))).toBe(true);
	});
});
