# `common/` mapping: 62 shared Svelte components → shadcn/ui or custom

`apps/openwebui/src/lib/components/common/` (62 components, per the migration
plan's own "Key facts") is the shared UI kit every surface (chat, workspace,
admin, benchmarks) built on. This records where each one lands, so a later
phase porting a surface that uses one doesn't have to re-derive the decision.
Nothing here is built yet -- Phase 4 owns the layout shell
(`src/components/layout/`), not this kit; components get built when the
first surface that needs them does (mostly Phases 7-10).

## Straightforward shadcn replacements

| Svelte component | shadcn/ui |
|---|---|
| `Modal.svelte`, `ConfirmDialog.svelte`, `InputModal.svelte` | `Dialog` / `AlertDialog` (destructive confirmations use `AlertDialog`, not `Dialog` -- per the shadcn skill's own guidance) |
| `Drawer.svelte`, `ResizableSidePanel.svelte`, `MobileSwipePanel.svelte` | `Sheet` |
| `Dropdown.svelte`, `DropdownMenu.svelte`, `DropdownOptions.svelte`, `DropdownSub.svelte` | `DropdownMenu` (already in use, see `components/layout/Sidebar.tsx`) |
| `Select.svelte`, `NativeSelect.svelte`, `SettingsSelect.svelte`, `MultiSelect.svelte`, `Selector.svelte` | `Select` (+ `Command`/`Popover` for the multi-select/combobox cases) |
| `Checkbox.svelte`, `Switch.svelte` | `Checkbox`, `Switch` |
| `Textarea.svelte`, `SensitiveInput.svelte` | `Textarea`, `Input` (`type="password"` + a reveal toggle for the latter) |
| `Badge.svelte`, `ExperimentalBadge.svelte` | `Badge` |
| `Tooltip.svelte`, `HotkeyHint.svelte` | `Tooltip` (already in use) |
| `Collapsible.svelte` | `Collapsible` |
| `Pagination.svelte` | `Pagination`-equivalent composed from `Button` (shadcn has no dedicated pagination primitive; a small custom composition, not a port) |
| `Loader.svelte`, `Spinner.svelte` | `Skeleton` for content placeholders; a plain spinning `Loader2` (lucide-react) icon for inline loading states |
| `Overlay.svelte` | Radix's own portal/overlay layer (comes for free with `Dialog`/`Sheet`/`Popover`; rarely needed standalone) |

## Kept custom (per the migration plan's own "Derived architecture decisions")

These have no shadcn equivalent and port as their own React components,
using the same underlying library where one exists:

| Svelte component | React port |
|---|---|
| `CodeEditor.svelte`, `CodeEditorModal.svelte` | CodeMirror (React bindings) |
| `RichTextInput.svelte`, `RichTextInput/` | TipTap (React bindings) |
| `PDFViewer.svelte`, `PdfPagesPreview.svelte` | Same PDF.js-based approach |
| `DocxPreview.svelte`, `PptxPreview.svelte` | Same underlying preview libraries |
| `EmojiPicker.svelte`, `Emoji.svelte` | Same emoji-picker library |
| `PanzoomContainer.svelte`, `SVGPanZoom.svelte` | Same pan/zoom library |
| `Valves.svelte`, `Valves/` | Custom (this is Open WebUI's own dynamic-form-from-schema renderer for tool/function config; no library replaces it) |

## Fork-owned or layout-adjacent (out of this table's scope)

`Sidebar.svelte` (common's own, distinct from `layout/Sidebar.svelte`),
`FileItem.svelte`/`FileItemModal.svelte`, `Folder.svelte`, `ChatList.svelte`,
`Tags.svelte`/`Tags/`, `Image.svelte`/`ImagePreview.svelte`, `Banner.svelte`,
`AccessButton.svelte`, `InterfaceSettings.svelte`, `FullHeightIframe.svelte`,
`Marquee.svelte`, `SlideShow.svelte`, `SplitCreateButton.svelte`,
`ToolCallDisplay.svelte`, `DragGhost.svelte` are feature-shaped rather than
generic-UI-shaped -- each belongs to whichever surface phase ports the
feature that uses it (chat, workspace, admin), not to a generic mapping
table. Listed here only so this file accounts for all 62 rather than
quietly dropping the ones that didn't fit the two categories above.
