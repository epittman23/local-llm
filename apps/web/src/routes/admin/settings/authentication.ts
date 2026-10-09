export type LdapServer = {
	label: string;
	host: string;
	port: number | null;
	attribute_for_mail: string;
	attribute_for_username: string;
	app_dn: string;
	app_dn_password: string;
	search_base: string;
	search_filters: string;
	use_tls: boolean;
	validate_cert: boolean;
	certificate_path: string;
	ciphers: string;
	enable_group_management: boolean;
	enable_group_creation: boolean;
	attribute_for_groups: string;
};

export const DEFAULT_GROUP_ATTRIBUTE = 'memberOf';

export const LDAP_DEFAULTS: LdapServer = {
	label: '',
	host: '',
	port: null,
	attribute_for_mail: 'mail',
	attribute_for_username: 'uid',
	app_dn: '',
	app_dn_password: '',
	search_base: '',
	search_filters: '',
	use_tls: false,
	validate_cert: false,
	certificate_path: '',
	ciphers: '',
	enable_group_management: false,
	enable_group_creation: false,
	attribute_for_groups: DEFAULT_GROUP_ATTRIBUTE
};

/** Server values laid over the defaults, so a key an older backend omits keeps its default. */
export const mergeLdapServer = (fromServer: Partial<LdapServer> | null | undefined): LdapServer => ({
	...LDAP_DEFAULTS,
	...fromServer
});

/**
 * What to send when saving: with group mapping on and the group attribute left
 * blank, use the default (the field's own hint says "Default to memberOf"), so
 * the backend's required-field check does not reject the save.
 */
export const ldapForSave = (server: LdapServer): LdapServer =>
	server.enable_group_management && !server.attribute_for_groups?.trim()
		? { ...server, attribute_for_groups: DEFAULT_GROUP_ATTRIBUTE }
		: server;

/** OAuth settings are editable unless the backend says they come from the environment. */
export const isOAuthEditable = (oauth: { ENABLE_OAUTH_PERSISTENT_CONFIG?: boolean } | null | undefined): boolean =>
	oauth?.ENABLE_OAUTH_PERSISTENT_CONFIG ?? true;
