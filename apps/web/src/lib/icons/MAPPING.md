# Icon mapping: custom SVG components → lucide-react

`apps/openwebui/src/lib/components/icons/` (182 components) and the per-feature
icon sets beside individual surfaces (e.g. `layout/Sidebar/icons/`) are one-off
Svelte wrappers around inline SVG. The migration plan's own decision
(`docs/migration-plan.md`, "Derived architecture decisions") is to replace all
of them with `lucide-react`, recorded here rather than ported.

**Scope for this phase (Phase 4, shared foundation):** only the icons the
layout shell (`src/components/layout/`) actually uses are mapped below. The
other ~165 are workspace/admin/chat-specific and get mapped when the phase
that ports their surface reaches them — mapping all 182 up front would mean
guessing at icons for UI that doesn't exist yet, several phases before it's
built (Phases 5-10 each own their own slice of this table).

| Open WebUI component | lucide-react | Used for |
|---|---|---|
| `icons/Sidebar.svelte` | `PanelLeft` | Collapse/expand the sidebar |
| `layout/Sidebar/icons/Search.svelte` | `Search` | Search chats |
| `layout/Sidebar/icons/EditPencil.svelte` | `SquarePen` | New chat |
| `layout/Sidebar/icons/Workspace.svelte` | `LayoutGrid` | Workspace nav item |
| `layout/Sidebar/icons/Notes.svelte` | `NotebookText` | Notes nav item |
| `layout/Sidebar/icons/Calendar.svelte` | `Calendar` | Calendar nav item |
| `icons/ChartBar.svelte` | `ChartBar` | Benchmarks nav item (fork-owned surface, Phase 5) |
| `layout/Sidebar/icons/MoreHorizontal.svelte` | `MoreHorizontal` | Row overflow menu |
| `icons/Check.svelte` | `Check` | Selected-item indicator |
| (no direct source; new to the React shell) | `ChevronDown` | User menu disclosure |
| (no direct source; new to the React shell) | `LogOut` | Sign out |
| (no direct source; new to the React shell) | `ShieldCheck` | Admin nav item |
| (no direct source; new to the React shell) | `X` | Close (mobile sheet) |

All at `h-4 w-4` (nav rows) or `h-5 w-5` (the sidebar's own collapse toggle),
per the shadcn skill's own default sizing guidance -- Open WebUI's originals
were also small and monochrome, so no visual-weight decision was made here
beyond matching that.
