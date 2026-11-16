import { useConfigStore } from '@/lib/stores/configStore';
import { useAccountCount, useSingleUser } from '@/routes/workspace/workspaceAccess';

/**
 * Whether Admin hides its multi-user parts (S5-D2, WRD-4): the install has one
 * account and sign-ups are off, so default roles and groups, pending accounts,
 * banners and the like say nothing to anyone. They come back as soon as a
 * second account exists or sign-ups are turned on. Users stays either way: it
 * is where a second account is made.
 *
 * The account count is `useSingleUser`'s (one cached query, counted as one
 * account until known); sign-ups are `/api/config`'s `enable_signup`.
 */
export function useAdminSingleUser(): boolean {
	const singleUser = useSingleUser();
	const signup = useConfigStore((s) => s.config?.features?.enable_signup === true);
	return singleUser && !signup;
}

/**
 * Whether the account count has answered (or failed): until then
 * `useAdminSingleUser` says one account by default, so a page must not act on
 * it irreversibly (redirect an address) before this is true.
 */
export function useAccountCountKnown(): boolean {
	const accounts = useAccountCount();
	return accounts.isSuccess || accounts.isError;
}
