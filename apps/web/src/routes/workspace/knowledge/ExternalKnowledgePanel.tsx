import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { testExternalKnowledgeRetrieval } from '@/lib/apis/knowledge';
import { useAuthStore } from '@/lib/stores/authStore';

type External = { provider?: string; connection_id?: string; source?: { name?: string }; [k: string]: unknown };
type TestResult = { documents?: string[]; metadatas?: Array<Record<string, any>>; distances?: number[] };

/**
 * Ports the "connected source" branch of KnowledgeBase.svelte: a knowledge base
 * backed by an external provider is read-only here (Open WebUI can query it but
 * not change it), so instead of a file list this shows what it is mapped to and
 * a test-query box.
 */
export function ExternalKnowledgePanel({ external }: { external: External }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [query, setQuery] = useState('');
	const [result, setResult] = useState<TestResult | null>(null);

	const test = async () => {
		if (!query.trim()) return;
		const res = await testExternalKnowledgeRetrieval(token, external.connection_id as string, {
			query,
			source: external.source,
			count: 5
		}).catch((e) => {
			toast.error(`${e}`);
			return null;
		});
		if (res) setResult(res);
	};

	const chip = 'bg-muted rounded-lg px-2 py-1';
	const box = 'bg-muted rounded-xl px-3 py-2';
	return (
		<div className="flex flex-col gap-4 p-5">
			<div className="flex flex-wrap gap-2 text-xs">
				<div className={chip}>Connected</div>
				<div className={chip}>Read Only</div>
				<div className={chip}>{external.provider ?? 'Provider'}</div>
				<div className={chip}>Service Account</div>
			</div>
			<div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
				<div>
					<div className="text-muted-foreground mb-1 text-xs">Mapped Source</div>
					<div className={box}>{external.source?.name ?? 'Not configured'}</div>
				</div>
				<div>
					<div className="text-muted-foreground mb-1 text-xs">Auth Mode</div>
					<div className={box}>Admin-managed service account</div>
				</div>
			</div>
			<div className="text-muted-foreground text-xs">
				{/* LICENSE covers this Open WebUI wordmark.
				    Do not alter, remove, obscure, or replace it except as LICENSE permits:
				    https://docs.openwebui.com/license. */}
				This knowledge base retrieves from a connected source. Open WebUI can query it, but cannot upload, sync, edit,
				delete, reset, or reindex its source data.
			</div>
			<div className="flex flex-col gap-2">
				<div className="text-xs">Test Query</div>
				<div className="flex gap-2">
					<input
						className="bg-muted w-full rounded-xl px-3 py-2 text-xs outline-hidden"
						aria-label="Test Query"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => e.key === 'Enter' && test()}
						placeholder="Ask this knowledge source a test question"
					/>
					<Button size="sm" onClick={test}>
						Test
					</Button>
				</div>
			</div>
			{result && (
				<div className="bg-muted rounded-xl p-3 text-xs">
					<div className="mb-2">Preview</div>
					{(result.documents ?? []).map((doc, idx) => (
						<div key={idx} className="border-t py-2">
							<div className="line-clamp-4">{doc}</div>
							<div className="text-muted-foreground mt-1">{result.metadatas?.[idx]?.source ?? ''}</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
