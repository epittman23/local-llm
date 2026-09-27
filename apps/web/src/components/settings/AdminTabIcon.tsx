import {
	Archive,
	BarChart3,
	Bell,
	CircleUser,
	Info,
	Keyboard,
	Sparkles,
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
	db: Database,
	notifications: Bell,
	shortcuts: Keyboard,
	tools: Wrench,
	personalization: Sparkles,
	data_controls: Database,
	archived_chats: Archive,
	account: CircleUser,
	about: Info
};

/** Ports admin/Settings/AdminTabIcon.svelte: the small glyph beside each Settings tab (personal ids share the admin glyphs where the names match). */
export function AdminTabIcon({ id, className = 'size-3.5' }: { id: string; className?: string }) {
	const Icon = icons[id] ?? Settings;
	return <Icon className={className} strokeWidth={2} aria-hidden />;
}
