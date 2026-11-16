import { useQuery } from '@tanstack/react-query';
import { getOllamaVersion } from '@/lib/apis/ollama';
import { getOpenAIConfig } from '@/lib/apis/openai';
import { WEBUI_BUILD_HASH } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useWebUIName } from '@/lib/stores/configStore';
import { SettingRow, SettingsForm, SettingsSection } from '../controls';

/** The Open WebUI release this app was forked from (NOTICE). */
export const FORKED_FROM = 'v0.11.3';

/** NOTICE's copyright line, word for word: About "shows the same license and copyright lines" (NOTICE). */
export const UPSTREAM_COPYRIGHT =
	'Copyright (c) 2023- Open WebUI Inc. [Created by Timothy Jaeryang Baek] All rights reserved.';

/**
 * Ports Settings/About.svelte, rewritten for this app (#1003): what was built
 * (the git commit and the build day), the server it talks to, for an admin
 * the model connections' addresses, the Ollama
 * version when there is one, then where it came from. There is no update
 * check (a hard fork has no upstream releases to compare against). The
 * attribution matches NOTICE word for word; a test reads NOTICE to keep it so.
 */
export default function About() {
	const token = useAuthStore((s) => s.token) ?? '';
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const name = useWebUIName();
	const ollama = useQuery({
		queryKey: ['ollama-version'],
		queryFn: async () => ((await getOllamaVersion(token).catch(() => '')) as string) || ''
	});
	// The connections the models come from. Only an admin may read them, so
	// for anyone else the row is left out rather than shown failing.
	const connections = useQuery({
		queryKey: ['about-openai-connections'],
		enabled: isAdmin,
		queryFn: async (): Promise<string[]> => {
			const config = await getOpenAIConfig(token).catch(() => null);
			return config?.ENABLE_OPENAI_API === false ? [] : (config?.OPENAI_API_BASE_URLS ?? []);
		}
	});

	return (
		<SettingsForm title="About" footer={false}>
			<SettingsSection title={name} first>
				<SettingRow label="Build" description="The commit this copy was built from, and the day it was built.">
					{() => (
						<span className="font-mono text-dense">
							{WEBUI_BUILD_HASH} · {APP_BUILD_DATE}
						</span>
					)}
				</SettingRow>
				<SettingRow label="Server" description="The address this app talks to.">
					{() => <span className="font-mono text-dense">{window.location.origin}</span>}
				</SettingRow>
				{connections.data && connections.data.length > 0 && (
					<SettingRow
						label="Model connections"
						description="The OpenAI-compatible addresses the models come from (Admin > Settings > Connections)."
					>
						{() => (
							<span className="flex flex-col items-end gap-1">
								{connections.data.map((url) => (
									<span key={url} className="font-mono text-dense break-all">
										{url}
									</span>
								))}
							</span>
						)}
					</SettingRow>
				)}
				{ollama.data && (
					<SettingRow label="Ollama" description="The version of the Ollama server, when one is connected.">
						{() => <span className="font-mono text-dense">{ollama.data}</span>}
					</SettingRow>
				)}
			</SettingsSection>
			<SettingsSection title="License">
				<p className="text-foreground-muted text-dense">
					Derived from Open WebUI {FORKED_FROM} (see NOTICE). Portions remain under its license.
				</p>
				<p className="text-foreground-muted text-dense">{UPSTREAM_COPYRIGHT}</p>
			</SettingsSection>
		</SettingsForm>
	);
}
