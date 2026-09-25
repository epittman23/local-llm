import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import { BoundSecret as Secret, BoundText as Text, BoundToggle as Toggle } from '@/components/settings/boundFields';
import { SettingField, SettingNumber, SettingRow, SettingSelect, SettingSwitch, SettingTextarea, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { getAdminConfig, getLdapConfig, getLdapServer, getOAuthConfig, updateAdminConfig, updateLdapConfig, updateLdapServer, updateOAuthConfig } from '@/lib/apis/auths';
import { getGroups } from '@/lib/apis/groups';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { type LdapServer, isOAuthEditable, ldapForSave, mergeLdapServer } from './authentication';

type Rec = Record<string, any>;
type Draft = { admin: Rec; groups: { id: string; name: string }[]; ldapEnabled: boolean; ldap: LdapServer; oauth: Rec | null };

const linkClass = 'text-muted-foreground/70 hover:text-foreground mt-1 block text-[0.6875rem] underline';
const externalLink = { target: '_blank', rel: 'noopener noreferrer' } as const;
const grid = 'grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2';
const warnClass = 'mt-1 block rounded-lg bg-yellow-500/10 px-2 py-1.5 text-[0.6875rem] text-yellow-700 dark:text-yellow-200';

function UserAccess({ admin, set, groups }: { admin: Rec; set: (p: Rec) => void; groups: Draft['groups'] }) {
	return (
		<SettingsSection title="User Access" first>
			<SettingRow label="Default User Role" description="Role assigned to new users when they create an account.">
				<SettingSelect value={admin.DEFAULT_USER_ROLE} onChange={(v) => set({ DEFAULT_USER_ROLE: v })} aria-label="Default User Role">
					<option value="pending">pending</option>
					<option value="user">user</option>
					<option value="admin">admin</option>
				</SettingSelect>
			</SettingRow>

			<SettingRow label="Default Group" description="Group assigned to new users by default.">
				<SettingSelect value={admin.DEFAULT_GROUP_ID} onChange={(v) => set({ DEFAULT_GROUP_ID: v })} aria-label="Default Group">
					<option value="">None</option>
					{groups.map((g) => (
						<option key={g.id} value={g.id}>
							{g.name}
						</option>
					))}
				</SettingSelect>
			</SettingRow>

			<Toggle config={admin} set={set} name="ENABLE_SIGNUP" label="New Sign Ups" description="Allow new users to create accounts." />
			<Toggle config={admin} set={set} name="ENABLE_API_KEYS" label="API Keys" description="Allow users to create API keys for programmatic access." />

			{admin.ENABLE_API_KEYS && (
				<>
					<Toggle config={admin} set={set} name="ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS" label="API Key Endpoint Restrictions" description="Limit API keys to configured endpoints." />
					{admin.ENABLE_API_KEYS_ENDPOINT_RESTRICTIONS && (
						<Text
							config={admin}
							set={set}
							name="API_KEYS_ALLOWED_ENDPOINTS"
							label="Allowed Endpoints"
							description="Comma-separated API paths that API keys can access."
							placeholder="e.g.) /api/v1/messages, /api/v1/channels"
						>
							<a className={linkClass} href="https://docs.openwebui.com/reference/api-endpoints" {...externalLink}>
								To learn more about available endpoints, visit our documentation.
							</a>
						</Text>
					)}
				</>
			)}

			<Text
				config={admin}
				set={set}
				name="JWT_EXPIRES_IN"
				label="JWT Expiration"
				description="Valid time units: 's', 'm', 'h', 'd', 'w' or '-1' for no expiration."
				placeholder={`e.g.) "30m","1h", "10d". `}
			>
				{admin.JWT_EXPIRES_IN === '-1' && (
					<a className={`${warnClass} underline`} href="https://docs.openwebui.com/reference/env-configuration#jwt_expires_in" {...externalLink}>
						No expiration can pose security risks.
					</a>
				)}
			</Text>
		</SettingsSection>
	);
}

function PendingAccounts({ admin, set }: { admin: Rec; set: (p: Rec) => void }) {
	return (
		<SettingsSection title="Pending Accounts">
			<Toggle config={admin} set={set} name="SHOW_ADMIN_DETAILS" label="Admin Details" description="Show admin contact details while an account waits for approval." />
			{admin.SHOW_ADMIN_DETAILS && (
				<Text config={admin} set={set} name="ADMIN_EMAIL" type="email" label="Admin Contact Email" description="Email shown in the pending account overlay." placeholder="Leave empty to use first admin user" />
			)}
			<SettingField label="Pending User Overlay Title" description="Custom title shown while an account waits for approval." htmlFor="auth-overlay-title">
				<SettingTextarea
					id="auth-overlay-title"
					placeholder="Enter a title for the pending user info overlay. Leave empty for default."
					value={admin.PENDING_USER_OVERLAY_TITLE ?? ''}
					onChange={(e) => set({ PENDING_USER_OVERLAY_TITLE: e.target.value })}
				/>
			</SettingField>
			<SettingField label="Pending User Overlay Content" description="Custom message shown while an account waits for approval." htmlFor="auth-overlay-content">
				<SettingTextarea
					id="auth-overlay-content"
					placeholder="Enter content for the pending user info overlay. Leave empty for default."
					value={admin.PENDING_USER_OVERLAY_CONTENT ?? ''}
					onChange={(e) => set({ PENDING_USER_OVERLAY_CONTENT: e.target.value })}
				/>
			</SettingField>
		</SettingsSection>
	);
}

function Ldap({ enabled, setEnabled, ldap, set }: { enabled: boolean; setEnabled: (v: boolean) => void; ldap: LdapServer; set: (p: Partial<LdapServer>) => void }) {
	return (
		<SettingsSection title="LDAP">
			<SettingRow label="LDAP" description="Allow users to authenticate with an LDAP directory.">
				{(id) => <SettingSwitch checked={enabled} onChange={setEnabled} labelledBy={id} />}
			</SettingRow>

			{enabled && (
				<>
					<div className={grid}>
						<Text config={ldap} set={set} name="label" required label="Label" description="Display name for this LDAP connection." placeholder="Enter server label" />
					</div>
					<div className={grid}>
						<Text config={ldap} set={set} name="host" required label="Host" description="LDAP server hostname or IP address." placeholder="Enter server host" />
						<SettingField label="Port" description="LDAP server port." htmlFor="auth-port">
							<Tip content="Default to 389 or 636 if TLS is enabled">
								<SettingNumber id="auth-port" placeholder="Enter server port" value={ldap.port} onChange={(v) => set({ port: v === '' ? null : v })} />
							</Tip>
						</SettingField>
					</div>
					<div className={grid}>
						<Text config={ldap} set={set} name="app_dn" label="Application DN" description="Bind DN used for directory search." placeholder="Enter Application DN" tip="The Application Account DN you bind with for search" />
						<Secret config={ldap} set={set} name="app_dn_password" label="Application DN Password" description="Password for the bind DN." placeholder="Enter Application DN Password" />
					</div>
					<div className={grid}>
						<Text
							config={ldap}
							set={set}
							name="attribute_for_mail"
							required
							label="Attribute for Mail"
							description="LDAP attribute used as the user email address."
							placeholder="Example: mail"
							tip="The LDAP attribute that maps to the mail that users use to sign in."
						/>
						<Text
							config={ldap}
							set={set}
							name="attribute_for_username"
							required
							label="Attribute for Username"
							description="LDAP attribute used as the username."
							placeholder="Example: sAMAccountName or uid or userPrincipalName"
							tip="The LDAP attribute that maps to the username that users use to sign in."
						/>
					</div>
					<Text
						config={ldap}
						set={set}
						name="search_base"
						required
						label="Search Base"
						description="Base DN used when searching for users."
						placeholder="Example: ou=users,dc=foo,dc=example"
						tip="The base to search for users"
					/>
					<Text config={ldap} set={set} name="search_filters" label="Search Filters" description="LDAP filter used to match signing-in users." placeholder="Example: (&(objectClass=inetOrgPerson)(uid=%s))">
						<a className={linkClass} href="https://ldap.com/ldap-filters/" {...externalLink}>
							Click here for filter guides.
						</a>
					</Text>

					<Toggle config={ldap} set={set} name="use_tls" label="TLS" description="Use TLS when connecting to the LDAP server." />
					{ldap.use_tls && (
						<>
							<Text config={ldap} set={set} name="certificate_path" label="Certificate Path" description="Certificate file used for TLS verification." placeholder="Enter certificate path" />
							<Toggle config={ldap} set={set} name="validate_cert" label="Validate Certificate" description="Verify the LDAP server certificate when TLS is enabled." />
							<Text config={ldap} set={set} name="ciphers" label="Ciphers" description="TLS cipher list for LDAP connections." placeholder="Example: ALL" tip="Default to ALL" />
						</>
					)}

					{/* LICENSE covers this Open WebUI wordmark.
					    Do not alter, remove, obscure, or replace it except as LICENSE permits:
					    https://docs.openwebui.com/license. */}
					<Toggle config={ldap} set={set} name="enable_group_management" label="Group Mapping" description="Map LDAP groups to Open WebUI groups." />
					{ldap.enable_group_management && (
						<>
							<Toggle config={ldap} set={set} name="enable_group_creation" label="Auto-Create Groups" description="Create missing groups from LDAP groups." />
							<Text config={ldap} set={set} name="attribute_for_groups" label="Group Attribute" description="LDAP attribute containing the user group memberships." placeholder="memberOf" tip="Default to memberOf" />
						</>
					)}
				</>
			)}
		</SettingsSection>
	);
}

function OAuth({ oauth, set }: { oauth: Rec; set: (p: Rec) => void }) {
	const editable = isOAuthEditable(oauth);
	const text = (name: string, label: string, description: string, placeholder?: string) => (
		<Text config={oauth} set={set} name={name} label={label} description={description} placeholder={placeholder} />
	);
	const toggle = (name: string, label: string, description: string) => <Toggle config={oauth} set={set} name={name} label={label} description={description} />;

	return (
		<SettingsSection title="OAuth / OIDC">
			{!editable && (
				<div className={warnClass}>
					These settings are read from environment variables and cannot be edited here while ENABLE_OAUTH_PERSISTENT_CONFIG is disabled.
				</div>
			)}
			<fieldset className="flex min-w-0 flex-col gap-2.5 disabled:cursor-not-allowed disabled:opacity-75" disabled={!editable}>
				{toggle('ENABLE_OAUTH', 'OAuth / OIDC', 'Allow users to authenticate with an OAuth / OIDC provider.')}

				{oauth.ENABLE_OAUTH && (
					<>
						<div className={grid}>
							{text('OAUTH_PROVIDER_NAME', 'Provider Name', 'Display name shown for the OAuth provider.', 'SSO')}
							{text('OPENID_PROVIDER_URL', 'Provider URL', 'OpenID discovery URL for this provider.', 'https://accounts.google.com/.well-known/openid-configuration')}
						</div>
						<div className={grid}>
							{text('OAUTH_CLIENT_ID', 'Client ID', 'OAuth client identifier from the provider.', 'Enter Client ID')}
							<Secret config={oauth} set={set} name="OAUTH_CLIENT_SECRET" label="Client Secret" description="OAuth client secret from the provider." placeholder="Enter Client Secret" />
						</div>
						<div className={grid}>
							{text('OPENID_REDIRECT_URI', 'Redirect URI', 'Callback URI registered with the provider.', 'Enter Redirect URI')}
							{text('OAUTH_SCOPES', 'Scopes', 'OAuth scopes requested during sign-in.', 'openid email profile')}
						</div>
						<div className={grid}>
							{text('OAUTH_EMAIL_CLAIM', 'Email Claim', 'Claim used as the user email address.', 'email')}
							{text('OAUTH_USERNAME_CLAIM', 'Username Claim', 'Claim used as the display name.', 'name')}
						</div>
						<div className={grid}>
							{text('OAUTH_PICTURE_CLAIM', 'Picture Claim', 'Claim used as the profile picture URL.', 'picture')}
							{text('OAUTH_SUB_CLAIM', 'Sub Claim', 'Claim used as the stable user identifier.', 'sub')}
						</div>

						{toggle('ENABLE_OAUTH_SIGNUP', 'OAuth Signup', 'Allow users to create accounts through OAuth.')}
						{toggle('OAUTH_MERGE_ACCOUNTS_BY_EMAIL', 'Merge Accounts by Email', 'Link OAuth sign-ins to existing accounts with the same email.')}
						{toggle('OAUTH_AUTO_REDIRECT', 'Auto Redirect', 'Send users directly to the OAuth provider from the sign-in page.')}
						{text('OAUTH_ALLOWED_DOMAINS', 'Allowed Domains', 'Email domains allowed to sign in with OAuth.', '* (all domains)')}

						{/* LICENSE covers this Open WebUI wordmark.
						    Do not alter, remove, obscure, or replace it except as LICENSE permits:
						    https://docs.openwebui.com/license. */}
						{toggle('ENABLE_OAUTH_ROLE_MANAGEMENT', 'Role Mapping', 'Map OAuth claims to Open WebUI roles.')}
						{oauth.ENABLE_OAUTH_ROLE_MANAGEMENT && (
							<>
								<div className={grid}>
									{text('OAUTH_ROLES_CLAIM', 'Roles Claim', 'Claim containing provider roles.', 'roles')}
									{text('OAUTH_ADMIN_ROLES', 'Admin Roles', 'Provider roles that grant admin access.', 'admin')}
								</div>
								{text('OAUTH_ALLOWED_ROLES', 'Allowed Roles', 'Provider roles allowed to sign in.', '*')}
							</>
						)}

						{/* LICENSE covers this Open WebUI wordmark.
						    Do not alter, remove, obscure, or replace it except as LICENSE permits:
						    https://docs.openwebui.com/license. */}
						{toggle('ENABLE_OAUTH_GROUP_MANAGEMENT', 'Group Mapping', 'Map OAuth claims to Open WebUI groups.')}
						{oauth.ENABLE_OAUTH_GROUP_MANAGEMENT && (
							<>
								{toggle('ENABLE_OAUTH_GROUP_CREATION', 'Auto-Create Groups', 'Create missing groups from OAuth claims.')}
								<div className={grid}>
									{text('OAUTH_GROUP_CLAIM', 'Group Claim', 'Claim containing provider groups.', 'groups')}
									{text('OAUTH_BLOCKED_GROUPS', 'Blocked Groups', 'Provider groups blocked from signing in.', 'Comma-separated group names')}
								</div>
							</>
						)}

						{toggle('OAUTH_UPDATE_EMAIL_ON_LOGIN', 'Update Email', 'Refresh the account email from OAuth on sign-in.')}
						{toggle('OAUTH_UPDATE_NAME_ON_LOGIN', 'Update Name', 'Refresh the account name from OAuth on sign-in.')}
						{toggle('OAUTH_UPDATE_PICTURE_ON_LOGIN', 'Update Picture', 'Refresh the profile picture from OAuth on sign-in.')}
					</>
				)}
			</fieldset>
		</SettingsSection>
	);
}

/** Ports admin/Settings/Authentication.svelte. */
export default function Authentication() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const { draft, setDraft, isLoading } = useConfigDraft<Draft>(['authentication'], async () => {
		const [admin, groups, ldap, oauth, ldapConfig] = await Promise.all([
			getAdminConfig(token),
			getGroups(token),
			getLdapServer(token),
			getOAuthConfig(token).catch(() => null),
			getLdapConfig(token)
		]);
		return { admin, groups: groups ?? [], ldapEnabled: Boolean(ldapConfig?.ENABLE_LDAP), ldap: mergeLdapServer(ldap), oauth };
	});
	const [saving, setSaving] = useState(false);

	const setAdmin = (p: Rec) => setDraft((d) => d && { ...d, admin: { ...d.admin, ...p } });
	const setLdap = (p: Partial<LdapServer>) => setDraft((d) => d && { ...d, ldap: { ...d.ldap, ...p } });
	const setOAuth = (p: Rec) => setDraft((d) => d && { ...d, oauth: d.oauth && { ...d.oauth, ...p } });

	/** Runs one save request; a failure toasts and reports false rather than throwing. */
	const attempt = async (request: () => Promise<unknown>) => {
		try {
			return Boolean(await request());
		} catch (error) {
			toast.error(`${error}`);
			return false;
		}
	};

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			// Each part is its own request and none stops the others, so a bad LDAP
			// server does not lose the admin config edits (and vice versa).
			const adminSaved = await attempt(() => updateAdminConfig(token, draft.admin));
			const ldapSaved = await attempt(async () => {
				await updateLdapConfig(token, draft.ldapEnabled);
				return draft.ldapEnabled ? updateLdapServer(token, ldapForSave(draft.ldap)) : true;
			});
			let oauthSaved = true;
			if (draft.oauth && isOAuthEditable(draft.oauth)) {
				const oauth = draft.oauth;
				oauthSaved = await attempt(async () => {
					const res = await updateOAuthConfig(token, oauth);
					if (res) setDraft((d) => d && { ...d, oauth: res });
					return res;
				});
			}
			if (adminSaved && ldapSaved && oauthSaved) await saved();
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsForm title="Authentication" loading={isLoading} onSubmit={save} saving={saving}>
			{draft && (
				<>
					<UserAccess admin={draft.admin} set={setAdmin} groups={draft.groups} />
					<PendingAccounts admin={draft.admin} set={setAdmin} />
					<Ldap enabled={draft.ldapEnabled} setEnabled={(v) => setDraft((d) => d && { ...d, ldapEnabled: v })} ldap={draft.ldap} set={setLdap} />
					{draft.oauth && <OAuth oauth={draft.oauth} set={setOAuth} />}
				</>
			)}
		</SettingsForm>
	);
}
