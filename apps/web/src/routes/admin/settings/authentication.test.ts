import { describe, expect, it } from 'vitest';
import { LDAP_DEFAULTS, isOAuthEditable, ldapForSave, mergeLdapServer } from './authentication';

describe('mergeLdapServer', () => {
	it('keeps a default for any key the server omits, and takes what it sends', () => {
		const merged = mergeLdapServer({ label: 'Corp', host: 'ldap.corp', port: 636 });
		expect(merged).toEqual({ ...LDAP_DEFAULTS, label: 'Corp', host: 'ldap.corp', port: 636 });
		expect(merged.attribute_for_groups).toBe('memberOf');
	});
	it('is just the defaults for a null answer', () => {
		expect(mergeLdapServer(null)).toEqual(LDAP_DEFAULTS);
	});
});

describe('ldapForSave', () => {
	const on = { ...LDAP_DEFAULTS, enable_group_management: true };
	it('fills a blank group attribute while group mapping is on', () => {
		expect(ldapForSave({ ...on, attribute_for_groups: '' }).attribute_for_groups).toBe('memberOf');
		expect(ldapForSave({ ...on, attribute_for_groups: '   ' }).attribute_for_groups).toBe('memberOf');
	});
	it('leaves a chosen attribute, and a blank one while mapping is off, alone', () => {
		expect(ldapForSave({ ...on, attribute_for_groups: 'groups' }).attribute_for_groups).toBe('groups');
		const off = { ...LDAP_DEFAULTS, attribute_for_groups: '' };
		expect(ldapForSave(off)).toBe(off);
	});
});

describe('isOAuthEditable', () => {
	it('is editable unless persistent config is explicitly off', () => {
		expect(isOAuthEditable({ ENABLE_OAUTH_PERSISTENT_CONFIG: true })).toBe(true);
		expect(isOAuthEditable({})).toBe(true);
		expect(isOAuthEditable(null)).toBe(true);
		expect(isOAuthEditable({ ENABLE_OAUTH_PERSISTENT_CONFIG: false })).toBe(false);
	});
});
