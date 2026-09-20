import {
	BarChart3,
	Bot,
	Box,
	Code,
	Database,
	FileText,
	Globe,
	Image,
	Link,
	ListOrdered,
	Lock,
	type LucideIcon,
	Monitor,
	Settings,
	ThumbsUp,
	Volume2,
	Wrench
} from 'lucide-react';

const icons: Record<string, LucideIcon> = {
	general: Settings,
	authentication: Lock,
	connections: Link,
	models: Box,
	subagents: Bot,
	interface: Monitor,
	audio: Volume2,
	images: Image,
	evaluations: ThumbsUp,
	analytics: BarChart3,
	integrations: Wrench,
	documents: FileText,
	web: Globe,
	'code-execution': Code,
	pipelines: ListOrdered,
	db: Database
};

/** Ports admin/Settings/AdminTabIcon.svelte: the small glyph beside each admin tab. */
export function AdminTabIcon({ id, className = 'size-3.5' }: { id: string; className?: string }) {
	const Icon = icons[id] ?? Settings;
	return <Icon className={className} strokeWidth={2} aria-hidden />;
}
