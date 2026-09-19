import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { getBackendConfig } from '@/lib/apis';
import { getSessionUser, ldapUserSignIn, updateUserTimezone, userSignIn, userSignUp } from '@/lib/apis/auths';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { generateInitialsImage, getUserTimezone } from '@/lib/utils/auth-helpers';
import { routePaths } from '@/routes/routePaths';

type Mode = 'ldap' | 'signin' | 'signup';

const OAUTH_PROVIDER_LABELS: Record<string, string> = {
	google: 'Google',
	microsoft: 'Microsoft',
	github: 'GitHub',
	oidc: 'SSO',
	feishu: 'Feishu'
};

/**
 * Ports apps/openwebui/src/routes/auth/+page.svelte: sign-in/sign-up/LDAP,
 * OAuth provider buttons + callback handling, the trusted-header and
 * auto-redirect-to-SSO bypasses, onboarding, and the login footer markdown.
 *
 * Two deliberate simplifications, both cosmetic: the onboarding screen is a
 * plain card ("Welcome — Get Started") instead of OnBoarding.svelte's
 * autoplaying background video (its own asset, /assets/welcome.mp4, is
 * Open WebUI's own branded footage this repo has no reason to vendor for a
 * functionally identical CTA); and OAuth provider buttons are plain labeled
 * buttons instead of hand-drawn brand SVGs -- same click target, same
 * `${WEBUI_BASE_URL}/oauth/<provider>/login` destination, no per-brand icon.
 *
 * Toasts are still absent everywhere in this app (see lib/auth/session.ts's
 * own note) -- errors render as an inline banner instead.
 */
export function AuthPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const config = useConfigStore((state) => state.config);
	const WEBUI_NAME = useWebUIName();
	const setSession = useAuthStore((state) => state.setSession);
	const authStatus = useAuthStore((state) => state.status);

	const [mode, setMode] = useState<Mode>(config?.features?.enable_ldap ? 'ldap' : 'signin');
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [ldapUsername, setLdapUsername] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [onboarding, setOnboarding] = useState(false);
	const ranOnce = useRef(false);

	const form = searchParams.get('form');
	const redirectParam = searchParams.get('redirect');
	const isLogout = searchParams.get('state') === 'logout';

	const finishSignIn = async (sessionUser: any, redirectPath?: string | null) => {
		if (!sessionUser) return;

		if (sessionUser.token) {
			localStorage.token = sessionUser.token;
		}
		setSession(sessionUser.token, sessionUser);
		useConfigStore.getState().setConfig((await getBackendConfig()) ?? config ?? ({} as any));

		const timezone = getUserTimezone();
		if (sessionUser.token && timezone) {
			updateUserTimezone(sessionUser.token, timezone).catch((err) => console.error(err));
		}

		const target = redirectPath || redirectParam || routePaths.home;
		localStorage.removeItem('redirectPath');
		navigate(target, { replace: true });
	};

	const signInHandler = async () => {
		try {
			await finishSignIn(await userSignIn(email, password));
		} catch (err) {
			setError(String(err));
		}
	};

	const signUpHandler = async () => {
		if (config?.features?.enable_signup_password_confirmation && password !== confirmPassword) {
			setError('Passwords do not match.');
			return;
		}
		try {
			await finishSignIn(await userSignUp(name, email, password, generateInitialsImage(name)));
		} catch (err) {
			setError(String(err));
		}
	};

	const ldapSignInHandler = async () => {
		try {
			await finishSignIn(await ldapUserSignIn(ldapUsername, password));
		} catch (err) {
			setError(String(err));
		}
	};

	const submitHandler = async (e: React.FormEvent) => {
		e.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			if (mode === 'ldap') await ldapSignInHandler();
			else if (mode === 'signin') await signInHandler();
			else await signUpHandler();
		} finally {
			setSubmitting(false);
		}
	};

	// Runs once per mount: the OAuth callback check, the trusted-header/auto-
	// redirect-to-SSO bypasses, and onboarding -- all one-shot decisions made
	// from the URL and config as they stand at load time, not reactive state.
	useEffect(() => {
		// initAuth() (lib/auth/session.ts) fetches config *before* it settles
		// auth status, so status leaving 'pending' means the config attempt is
		// over. Running earlier would evaluate every decision below against a
		// null config and -- because of ranOnce -- never re-evaluate.
		if (authStatus === 'pending') return;
		if (ranOnce.current) return;
		ranOnce.current = true;

		// Settled with no config at all: the backend was unreachable.
		// +layout.svelte's own onMount sends this case to /error.
		if (!config) {
			navigate(routePaths.error, { replace: true });
			return;
		}

		// The useState initializer above ran while config was still null, so
		// the LDAP-first default (`$config?.features.enable_ldap ? 'ldap' :
		// 'signin'` in the source, evaluated with config already loaded) has to
		// be applied here, once, now that it's real.
		setMode(config.features?.enable_ldap ? 'ldap' : 'signin');

		(async () => {
			if (authStatus === 'authenticated' && !isLogout) {
				navigate(redirectParam || routePaths.home, { replace: true });
				return;
			}
			if (redirectParam) {
				localStorage.setItem('redirectPath', redirectParam);
			}

			const urlError = searchParams.get('error');
			if (urlError) setError(urlError);

			// OAuth callback: the backend's own redirect response set a `token`
			// cookie before landing the browser back here.
			const cookieMatch = document.cookie.match(/(?:^|; )token=([^;]*)/);
			const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
			if (cookieToken) {
				try {
					const sessionUser = await getSessionUser(cookieToken);
					await finishSignIn(
						{ ...sessionUser, token: cookieToken },
						localStorage.getItem('redirectPath')
					);
					return;
				} catch (err) {
					setError(String(err));
				}
			}

			// Auto-redirect to SSO when OAUTH_AUTO_REDIRECT is enabled and the
			// deployment is unambiguously SSO-only (single provider, no login
			// form, no LDAP). Suppressed after logout, by ?form=, ?error=,
			// onboarding, trusted-header auth, or an existing session/token.
			if (config?.oauth?.auto_redirect && !isLogout && !form && !urlError) {
				const providers = Object.keys(config?.oauth?.providers ?? {});
				if (
					providers.length === 1 &&
					config?.features?.auth !== false &&
					config?.features?.enable_login_form === false &&
					!config?.features?.enable_ldap &&
					!config?.features?.auth_trusted_header &&
					!config?.onboarding &&
					!localStorage.token &&
					!document.cookie.split('; ').some((c) => c.startsWith('token='))
				) {
					window.location.href = `${WEBUI_BASE_URL}/oauth/${providers[0]}/login`;
					return;
				}
			}

			if ((config?.features?.auth_trusted_header ?? false) || config?.features?.auth === false) {
				await signInHandler();
			} else {
				setOnboarding(config?.onboarding ?? false);
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [config, authStatus]);

	const oauthProviders = Object.keys(config?.oauth?.providers ?? {});
	const showLoginFields = config?.features?.enable_login_form || config?.features?.enable_ldap || !!form;
	const trustedOrNoAuth = (config?.features?.auth_trusted_header ?? false) || config?.features?.auth === false;

	if (authStatus === 'pending' || !config) {
		return (
			<div className="flex h-screen w-full items-center justify-center">
				<p className="text-muted-foreground text-sm">Loading…</p>
			</div>
		);
	}

	if (onboarding) {
		return (
			<div className="flex h-screen w-full items-center justify-center px-10 text-center">
				<div className="flex max-w-md flex-col items-center gap-4">
					<h1 className="text-2xl font-normal">Welcome to {WEBUI_NAME}</h1>
					<p className="text-muted-foreground text-sm">
						Get started by creating the first admin account for this instance.
					</p>
					<Button
						onClick={() => {
							setOnboarding(false);
							setMode(config?.features?.enable_ldap ? 'ldap' : 'signup');
						}}
					>
						Get Started
					</Button>
				</div>
			</div>
		);
	}

	if (trustedOrNoAuth) {
		return (
			<div className="flex h-screen w-full items-center justify-center">
				<p className="text-lg">Signing in to {WEBUI_NAME}…</p>
			</div>
		);
	}

	return (
		<div className="flex h-screen w-full items-center justify-center px-10">
			<div className="w-full max-w-md">
				<form className="flex flex-col justify-center" onSubmit={submitHandler}>
					<div className="mb-4 text-center text-2xl font-normal">
						{config?.onboarding
							? `Get started with ${WEBUI_NAME}`
							: mode === 'ldap'
								? `Sign in to ${WEBUI_NAME} with LDAP`
								: mode === 'signin'
									? `Sign in to ${WEBUI_NAME}`
									: `Sign up to ${WEBUI_NAME}`}
					</div>

					{error && (
						<div className="border-destructive/20 bg-destructive/10 text-destructive mb-3 rounded-lg border px-3 py-2 text-sm">
							{error}
						</div>
					)}

					{showLoginFields && (
						<div className="mt-2 flex flex-col gap-3">
							{mode === 'signup' && (
								<div className="flex flex-col gap-1 text-left">
									<Label htmlFor="name">Name</Label>
									<Input
										id="name"
										autoComplete="name"
										placeholder="Enter Your Full Name"
										value={name}
										onChange={(e) => setName(e.target.value)}
										required
									/>
								</div>
							)}

							{mode === 'ldap' ? (
								<div className="flex flex-col gap-1 text-left">
									<Label htmlFor="username">Username</Label>
									<Input
										id="username"
										autoComplete="username"
										placeholder="Enter Your Username"
										value={ldapUsername}
										onChange={(e) => setLdapUsername(e.target.value)}
										required
									/>
								</div>
							) : (
								<div className="flex flex-col gap-1 text-left">
									<Label htmlFor="email">Email</Label>
									<Input
										id="email"
										type="email"
										autoComplete="email"
										placeholder="Enter Your Email"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										required
									/>
								</div>
							)}

							<div className="flex flex-col gap-1 text-left">
								<Label htmlFor="password">Password</Label>
								<Input
									id="password"
									type="password"
									autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
									placeholder="Enter Your Password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									required
								/>
							</div>

							{mode === 'signup' && config?.features?.enable_signup_password_confirmation && (
								<div className="flex flex-col gap-1 text-left">
									<Label htmlFor="confirm-password">Confirm Password</Label>
									<Input
										id="confirm-password"
										type="password"
										autoComplete="new-password"
										placeholder="Confirm Your Password"
										value={confirmPassword}
										onChange={(e) => setConfirmPassword(e.target.value)}
										required
									/>
								</div>
							)}
						</div>
					)}

					<div className="mt-5">
						{showLoginFields && (
							<>
								<Button type="submit" className="w-full" disabled={submitting}>
									{submitting
										? 'Please wait…'
										: mode === 'ldap'
											? 'Authenticate'
											: mode === 'signin'
												? 'Sign in'
												: config?.onboarding
													? 'Create Admin Account'
													: 'Create Account'}
								</Button>

								{mode !== 'ldap' && config?.features?.enable_signup && !config?.onboarding && (
									<div className="mt-4 text-center text-sm">
										{mode === 'signin' ? "Don't have an account?" : 'Already have an account?'}{' '}
										<button
											type="button"
											className="underline"
											onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
										>
											{mode === 'signin' ? 'Sign up' : 'Sign in'}
										</button>
									</div>
								)}
							</>
						)}
					</div>
				</form>

				{oauthProviders.length > 0 && (
					<div className="mt-4 flex flex-col gap-2">
						{showLoginFields && (
							<div className="text-muted-foreground my-2 text-center text-sm">or</div>
						)}
						{oauthProviders.map((provider) => (
							<Button
								key={provider}
								type="button"
								variant="secondary"
								className="w-full"
								onClick={() => {
									window.location.href = `${WEBUI_BASE_URL}/oauth/${provider}/login`;
								}}
							>
								Continue with{' '}
								{OAUTH_PROVIDER_LABELS[provider] ?? config?.oauth?.providers?.[provider] ?? provider}
							</Button>
						))}
					</div>
				)}

				{config?.features?.enable_ldap && config?.features?.enable_login_form && (
					<button
						type="button"
						className="mt-2 w-full text-center text-xs underline"
						onClick={() => setMode(mode === 'ldap' ? (config?.onboarding ? 'signup' : 'signin') : 'ldap')}
					>
						{mode === 'ldap' ? 'Continue with Email' : 'Continue with LDAP'}
					</button>
				)}

				{config?.metadata?.login_footer && (
					<div
						className="text-muted-foreground mt-4 text-center text-xs"
						dangerouslySetInnerHTML={{
							__html: DOMPurify.sanitize(marked.parse(config.metadata.login_footer) as string)
						}}
					/>
				)}
			</div>
		</div>
	);
}
