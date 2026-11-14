import { CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { Label } from '@/components/ui/label';

// Building blocks of /ui (the interface standard's demo page). `Field` and
// `PageHeader` are the standard's own patterns (FRM-1, FRM-2, LAY-5), written
// once here so the page shows them the way a real page should use them.

export interface SectionMeta {
	id: string;
	title: string;
}

/** One chapter of the page: a heading the side navigation links to, and the rules it demonstrates. */
export function Section({
	id,
	title,
	rules,
	lead,
	children
}: SectionMeta & { rules: string[]; lead: string; children: ReactNode }) {
	return (
		<section id={id} aria-labelledby={`${id}-title`} className="border-border scroll-mt-6 border-t pt-8 pb-12">
			<div className="mb-6 max-w-[72ch]">
				<h2 id={`${id}-title`} className="text-heading font-[650] tracking-tight">
					{title}
				</h2>
				<p className="text-foreground-muted text-reading mt-2">{lead}</p>
				<p className="text-foreground-muted text-caption mt-3">
					Rules shown here:{' '}
					{rules.map((rule, i) => (
						<span key={rule}>
							{i > 0 && ', '}
							<code>{rule}</code>
						</span>
					))}
				</p>
			</div>
			<div className="flex flex-col gap-8">{children}</div>
		</section>
	);
}

/** A titled example inside a section, with the sentence that says what to look at. */
export function Example({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
	return (
		<div>
			<h3 className="text-title font-[650]">{title}</h3>
			{note && <p className="text-foreground-muted mt-1 mb-4 max-w-[72ch]">{note}</p>}
			<div className={note ? undefined : 'mt-4'}>{children}</div>
		</div>
	);
}

/** A raised panel on surface-1 with a divider edge (COL-5). */
export function Panel({ className = '', children }: { className?: string; children: ReactNode }) {
	return <div className={`border-border bg-surface-1 rounded-xl border p-4 ${className}`}>{children}</div>;
}

/**
 * FRM-1, FRM-2: the label sits above the control and stays visible; help text
 * sits below; an error replaces the help text, is announced, and is tied to
 * the control with aria-describedby.
 */
export function Field({
	label,
	optional,
	help,
	error,
	children
}: {
	label: string;
	optional?: boolean;
	help?: string;
	error?: string;
	children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
	const id = useId();
	const describedBy = error || help ? `${id}-note` : undefined;
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id} className="text-body font-[550]">
				{label}
				{optional && <span className="text-foreground-muted font-normal"> (optional)</span>}
			</Label>
			{children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
			{error ? (
				<p id={describedBy} role="alert" className="text-danger text-dense flex items-start gap-1.5">
					<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
					{error}
				</p>
			) : (
				help && (
					<p id={describedBy} className="text-foreground-muted text-dense">
						{help}
					</p>
				)
			)}
		</div>
	);
}

/** LAY-5: every page opens with its name, one sentence on what it is for, and its primary action. */
export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div className="min-w-0">
				<p className="text-heading font-[650] tracking-tight">{title}</p>
				<p className="text-foreground-muted mt-1 max-w-[72ch]">{description}</p>
			</div>
			{action}
		</div>
	);
}
