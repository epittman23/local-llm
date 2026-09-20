import { describe, expect, it } from 'vitest';
import { arenaIdFromName, buildArenaModel } from './arenaModels';

describe('arenaIdFromName', () => {
	it('lower-cases, collapses runs of punctuation into one dash and trims dashes', () => {
		expect(arenaIdFromName('My Arena  Model!')).toBe('my-arena-model');
		expect(arenaIdFromName('--A__B--')).toBe('a-b');
		expect(arenaIdFromName('Ünï')).toBe('n');
	});
});

describe('buildArenaModel', () => {
	const base = { id: 'a', name: 'A', profileImageUrl: '/x.png', description: '', modelIds: [], filterMode: 'exclude' as const, accessGrants: [] };
	it('uses null for an empty description and for "all models"', () => {
		expect(buildArenaModel(base).meta).toEqual({ profile_image_url: '/x.png', description: null, model_ids: null, filter_mode: null, access_grants: [] });
	});
	it('keeps the filter mode once specific models are listed', () => {
		expect(buildArenaModel({ ...base, description: 'd', modelIds: ['m1'] }).meta).toMatchObject({ description: 'd', model_ids: ['m1'], filter_mode: 'exclude' });
	});
});
