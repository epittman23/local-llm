/** OAuth settings are editable unless the backend says they come from the environment. */
export const isOAuthEditable = (oauth: { ENABLE_OAUTH_PERSISTENT_CONFIG?: boolean } | null | undefined): boolean =>
	oauth?.ENABLE_OAUTH_PERSISTENT_CONFIG ?? true;
