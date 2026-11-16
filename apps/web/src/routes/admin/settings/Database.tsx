import saveAs from 'file-saver';
import { Check, Copy } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { SettingRow, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { getAllUserChats } from '@/lib/apis/chats';
import { exportConfig, importConfig } from '@/lib/apis/configs';
import { getAllUsers } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useCopy } from '@/lib/ui/useCopy';
import { csvCell } from '@/lib/utils/csv';

/** id, name, email, role -- one CSV row per user; free-text cells are formula-neutralized. */
export function usersToCsv(users: Record<string, unknown>[]): string {
	const headers = ['id', 'name', 'email', 'role'];
	return [headers.join(','), ...users.map((user) => headers.map((h) => csvCell(user[h])).join(','))].join('\n');
}

/** `local-llm-config-2026-11-15.json`: what a download is and the day it was made (WRD-3). */
export const exportName = (what: string, ext: string, now = new Date()) =>
	`local-llm-${what}-${now.toISOString().slice(0, 10)}.${ext}`;

/**
 * The backup this app's database takes: a pg_dump inside the Postgres
 * container `make backend` starts (infra/docker-compose.yml names the
 * container, role and database), in the custom format pg_restore reads.
 */
export const BACKUP_COMMAND = 'docker exec local-llm-postgres pg_dump -Fc -U local_llm local_llm > local-llm.dump';

/** The database is Postgres, which the app cannot download for you: the command that backs it up, with Copy. */
function BackupNote() {
	const { copied, copy } = useCopy();
	return (
		<div data-setting="database-backup" className="flex flex-col gap-2">
			<div>
				<div className="text-foreground-strong font-strong">Database backup</div>
				<p className="text-foreground-muted mt-0.5 text-dense">
					The database is Postgres. Back it up from the machine running the stack with this command, which writes
					local-llm.dump for pg_restore.
				</p>
			</div>
			<div className="bg-surface-1 flex items-start gap-2 rounded-lg border py-1.5 ps-3 pe-1.5">
				<code className="text-foreground min-w-0 flex-1 py-1 font-mono text-dense break-all">{BACKUP_COMMAND}</code>
				<Button
					variant="outline"
					size="sm"
					type="button"
					aria-label={copied ? 'Copied' : 'Copy the pg_dump command'}
					onClick={() => copy(BACKUP_COMMAND, 'command')}
				>
					{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
					{copied ? 'Copied' : 'Copy'}
				</Button>
			</div>
		</div>
	);
}

/**
 * Ports admin/Settings/Database.svelte: settings import/export, the database
 * backup command, and (unless the backend turns them off) the chat and user
 * exports. Nothing here has a Save button; every action is its own.
 *
 * The Svelte tab's "Database" download only ever worked on SQLite, and this
 * app runs on Postgres, so it always failed; the backup command replaces it
 * and the route is gone (#961, S5-D5).
 *
 * The users CSV quotes every field in the original; here it goes through csvCell,
 * which also stops a user whose *name* is `=HYPERLINK(...)` from running as a
 * formula when the admin opens the file in a spreadsheet.
 */
export default function Database() {
	const token = useAuthStore((s) => s.token) ?? '';
	const config = useConfigStore((s) => s.config);
	const importInput = useRef<HTMLInputElement>(null);

	const importFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (event) => {
			try {
				const res = await importConfig(token, JSON.parse(String(event.target?.result)));
				if (res) toast.success('Settings imported');
			} catch (error) {
				toast.error(`${error}`);
			}
			if (importInput.current) importInput.current.value = '';
		};
		reader.readAsText(file);
	};

	const exportSettings = async () => {
		const exported = await exportConfig(token).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (exported)
			saveAs(new Blob([JSON.stringify(exported)], { type: 'application/json' }), exportName('config', 'json'));
	};

	const exportChats = async () => {
		try {
			const chats = await getAllUserChats(token);
			saveAs(new Blob([JSON.stringify(chats)], { type: 'application/json' }), exportName('chats', 'json'));
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	const exportUsers = async () => {
		try {
			const res = await getAllUsers(token);
			saveAs(new Blob([usersToCsv(res.users)], { type: 'text/csv;charset=utf-8;' }), exportName('users', 'csv'));
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	return (
		<SettingsForm title="Database" footer={false}>
			<input
				ref={importInput}
				id="config-json-input"
				hidden
				type="file"
				accept=".json"
				aria-label="Settings JSON file"
				onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
			/>
			<SettingsSection title="Settings" first>
				<SettingRow
					label="Settings file"
					description="Move the server settings between installs as JSON. Importing replaces the current settings."
				>
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" type="button" onClick={() => importInput.current?.click()}>
							Import settings
						</Button>
						<Button variant="outline" size="sm" type="button" onClick={exportSettings}>
							Export settings
						</Button>
					</div>
				</SettingRow>
			</SettingsSection>

			<SettingsSection title="Backup">
				<BackupNote />
			</SettingsSection>

			{(config?.features?.enable_admin_export ?? true) && (
				<SettingsSection title="Export">
					<SettingRow label="Chats" description="Every account's chat history, as JSON.">
						<Button variant="outline" size="sm" type="button" onClick={exportChats}>
							Export all chats
						</Button>
					</SettingRow>
					<SettingRow label="Users" description="Every account's name, email and role, as CSV.">
						<Button variant="outline" size="sm" type="button" onClick={exportUsers}>
							Export users
						</Button>
					</SettingRow>
				</SettingsSection>
			)}
		</SettingsForm>
	);
}
