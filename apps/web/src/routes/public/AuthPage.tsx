import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Tip } from '@/components/common/Tip';
import { BootSplash } from '@/components/layout/BootSplash';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getBackendConfig } from '@/lib/apis';
import { getSessionUser, updateUserTimezone, userSignIn, userSignUp } from '@/lib/apis/auths';
import { safeRedirect } from '@/lib/auth/redirect';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { generateInitialsImage, getUserTimezone } from '@/lib/utils/auth-helpers';
import { routePaths } from '@/routes/routePaths';

type Mode = 'signin' | 'signup';

const OAUTH_PROVIDER_LABELS: Record<string, string> = {
	google: 'Google',
	microsoft: 'Microsoft',
	github: 'GitHub',
	oidc: 'SSO',
	feishu: 'Feishu'
};

/**
 * Ports d863707:apps/openwebui/src/routes/auth/+page.svelte: sign-in/sign-up,
 * OAuth provider buttons + callback handling, the trusted-header and
 * auto-redirect-to-SSO bypasses, onboarding, and the login footer markdown.
 *
 * Two deliberate simplifications, both cosmetic: the onboarding screen is a
 * plain card ("Welcome — Get Started") instead of OnBoarding.svelte's
 * autoplaying background video (its own asset, /assets/welcome.mp4, is
 * the original project's branded footage this repo has no reason to vendor for a
 * functionally identical CTA); and OAuth provider buttons are plain labeled
 * buttons instead of hand-drawn brand SVGs -- same click target, same
 * `${WEBUI_BASE_URL}/oauth/<provider>/login` destination, no per-brand icon.
 *
 * LDAP sign-in, which the source also had, was removed on 2026-10-17.
 *
 * Errors render as an inline banner, not toasts, and so does the reason a
 * session ended (`?reason=expired`, FBK-1).
 */
export function AuthPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const config = useConfigStore((state) => state.config);
	const WEBUI_NAME = useWebUIName();
	const setSession = useAuthStore((state) => state.setSession);
	const authStatus = useAuthStore((state) => state.status);

	const [mode, setMode] = useState<Mode>('signin');
	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [onboarding, setOnboarding] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const ranOnce = useRef(false);
	const nameField = useRef<HTMLInputElement>(null);
	const emailField = useRef<HTMLInputElement>(null);
	const passwordField = useRef<HTMLInputElement>(null);

	const form = searchParams.get('form');
	const redirectParam = safeRedirect(searchParams.get('redirect'));
	const isLogout = searchParams.get('state') === 'logout';
	// Set by the route gate when the session ran out (lib/auth/useAuthGate.ts).
	const expired = searchParams.get('reason') === 'expired';

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
			// The password is what is most often wrong: selected, so typing replaces it.
			requestAnimationFrame(() => {
				passwordField.current?.focus();
				passwordField.current?.select();
			});
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

	const submitHandler = async (e: React.FormEvent) => {
		e.preventDefault();
		if (submitting) return;
		setSubmitting(true);
		setError(null);
		try {
			if (mode === 'signin') await signInHandler();
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
		// +layout.svelte's own onMount sends this case to /error, which comes
		// back to where the person was going once the server answers.
		if (!config) {
			const back = redirectParam ? `?redirect=${encodeURIComponent(redirectParam)}` : '';
			navigate(`${routePaths.error}${back}`, { replace: true });
			return;
		}

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
						safeRedirect(localStorage.getItem('redirectPath'))
					);
					return;
				} catch (err) {
					setError(String(err));
				}
			}

			// Auto-redirect to SSO when OAUTH_AUTO_REDIRECT is enabled and the
			// deployment is unambiguously SSO-only (single provider, no login
			// form). Suppressed after logout, by ?form=, ?error=,
			// onboarding, trusted-header auth, or an existing session/token.
			if (config?.oauth?.auto_redirect && !isLogout && !form && !urlError) {
				const providers = Object.keys(config?.oauth?.providers ?? {});
				if (
					providers.length === 1 &&
					config?.features?.auth !== false &&
					config?.features?.enable_login_form === false &&
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
	const showLoginFields = config?.features?.enable_login_form || !!form;
	const trustedOrNoAuth = (config?.features?.auth_trusted_header ?? false) || config?.features?.auth === false;
	const formShown = authStatus !== 'pending' && !!config && !onboarding && !trustedOrNoAuth && showLoginFields;

	// The first field to type in has focus (#1004): Email, Password when the
	// browser has already filled Email, or Name when signing up.
	useEffect(() => {
		if (!formShown) return;
		if (mode === 'signup') nameField.current?.focus();
		else if (emailField.current?.value) passwordField.current?.focus();
		else emailField.current?.focus();
	}, [formShown, mode]);

	// STA-2: the boot splash's look while the server's config arrives, never a bare "Loading…".
	if (authStatus === 'pending' || !config) return <BootSplash />;

	if (onboarding) {
		return (
			<main className="flex h-screen w-full items-center justify-center px-10 text-center">
				<div className="flex max-w-md flex-col items-center gap-4">
					<h1 className="text-heading font-title tracking-tight">Welcome to {WEBUI_NAME}</h1>
					<p className="text-foreground-muted">Get started by creating the first admin account for this instance.</p>
					<Button
						onClick={() => {
							setOnboarding(false);
							setMode('signup');
						}}
					>
						Get Started
					</Button>
				</div>
			</main>
		);
	}

	if (trustedOrNoAuth) {
		return (
			<main className="flex h-screen w-full items-center justify-center">
				<p className="text-title">Signing in to {WEBUI_NAME}…</p>
			</main>
		);
	}

	return (
		<main className="flex min-h-svh w-full flex-col px-4">
			{/* A third of the free space above and two below on a phone, where the keyboard rises; centred from sm up. */}
			<div aria-hidden className="flex-1" />
			<div className="mx-auto w-full max-w-sm">
				<form className="flex flex-col justify-center" onSubmit={submitHandler}>
					<h1 className="text-heading font-title mb-6 text-center tracking-tight">
						{config?.onboarding
							? `Get started with ${WEBUI_NAME}`
							: mode === 'signin'
								? `Sign in to ${WEBUI_NAME}`
								: `Sign up to ${WEBUI_NAME}`}
					</h1>

					{expired && !error && (
						<div
							role="alert"
							className="border-destructive/20 bg-destructive/10 text-destructive mb-3 rounded-lg border px-3 py-2 text-dense"
						>
							Your session expired. Sign in to continue where you left off.
						</div>
					)}

					{error && (
						<div
							role="alert"
							className="border-destructive/20 bg-destructive/10 text-destructive mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-dense"
						>
							<CircleAlert aria-hidden className="mt-px size-4 shrink-0" />
							<span>{error}</span>
						</div>
					)}

					{showLoginFields && (
						<div className="flex flex-col gap-4">
							{mode === 'signup' && (
								<div className="flex flex-col gap-1.5 text-left">
									<Label htmlFor="name">Name</Label>
									<Input
										id="name"
										ref={nameField}
										autoComplete="name"
										value={name}
										onChange={(e) => setName(e.target.value)}
										required
									/>
								</div>
							)}

							<div className="flex flex-col gap-1.5 text-left">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									ref={emailField}
									type="email"
									autoComplete="email"
									placeholder="you@example.com"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
								/>
							</div>

							<div className="flex flex-col gap-1.5 text-left">
								<Label htmlFor="password">Password</Label>
								<div className="relative">
									<Input
										id="password"
										ref={passwordField}
										type={showPassword ? 'text' : 'password'}
										autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										className="pe-11"
										required
									/>
									<Tip content={showPassword ? 'Hide password' : 'Show password'}>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="absolute inset-y-0 end-1 my-auto"
											aria-label={showPassword ? 'Hide password' : 'Show password'}
											aria-controls="password"
											onClick={() => setShowPassword((v) => !v)}
										>
											{showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
										</Button>
									</Tip>
								</div>
							</div>

							{mode === 'signup' && config?.features?.enable_signup_password_confirmation && (
								<div className="flex flex-col gap-1.5 text-left">
									<Label htmlFor="confirm-password">Confirm password</Label>
									<Input
										id="confirm-password"
										type={showPassword ? 'text' : 'password'}
										autoComplete="new-password"
										value={confirmPassword}
										onChange={(e) => setConfirmPassword(e.target.value)}
										required
									/>
								</div>
							)}
						</div>
					)}

					<div className="mt-6">
						{showLoginFields && (
							<>
								<Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting || undefined}>
									{submitting
										? mode === 'signin'
											? 'Signing in…'
											: 'Creating account…'
										: mode === 'signin'
											? 'Sign in'
											: config?.onboarding
												? 'Create admin account'
												: 'Create account'}
								</Button>

								{config?.features?.enable_signup && !config?.onboarding && (
									<div className="mt-4 text-center">
										{mode === 'signin' ? "Don't have an account?" : 'Already have an account?'}{' '}
										<Button
											type="button"
											variant="link"
											className="h-auto p-0"
											onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
										>
											{mode === 'signin' ? 'Sign up' : 'Sign in'}
										</Button>
									</div>
								)}
							</>
						)}
					</div>
				</form>

				{oauthProviders.length > 0 && (
					<div className="mt-4 flex flex-col gap-2">
						{showLoginFields && <div className="text-foreground-muted my-2 text-center">or</div>}
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
								Continue with {OAUTH_PROVIDER_LABELS[provider] ?? config?.oauth?.providers?.[provider] ?? provider}
							</Button>
						))}
					</div>
				)}
			</div>
			<div aria-hidden className="flex-2 sm:flex-1" />
		</main>
	);
}
