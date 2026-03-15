# Terminal UI migration Guide

The terminal-based UI surface that once rendered `@mariozechner/pi-tui` components is no longer active. Bindery web is today's interactive workspace, and the CLI/SDK run in headless mode for automation or tooling work. This page explains what changed, what to use now, and where the old TUI references still live for historical or troubleshooting purposes.

## What changed
- The TUI process (the terminal board that drew panes, overlays, and custom renderers) has been retired. There is no process that listens for `pi.ui.custom()` or `ctx.ui.custom()` components anymore, and `@mariozechner/pi-tui` is not shipped with the agent.
- Bindery web hosts interactive flows. It renders the message stream, tool output, extension cards, overlays, status rows, and commands in a single browser surface that mirrors session history and keeps tape-based navigation intact.
- The CLI/SDK continue to exist for headless use cases (`pi --print`, `pi --mode json`, `pi --mode rpc`, SDK clients, etc.), but they do not provide a live terminal view. Use them for automation, background tooling, or scripts that do not require user attention.

## Where to build interactive experiences now
- **Bindery web** is intentional about showing cards, widgets, and extension UI beside the conversation. Extensions can still post custom widgets (status, widgets, footers), overlays, and tool cards, but they render inside the browser rather than drawing ASCII art in a terminal. Think of each extension UI as a card inside the Bindery page instead of a terminal pane.
- **Extensions still emit events** via `ctx.ui.notify()`, `ctx.ui.setStatus()`, `ctx.ui.setWidget()`, and `ctx.ui.setFooter()`; those APIs now surface notifications or widgets in the web surface and in headless logs.
- **Headless automation** relies on the same APIs but only for communication and state; there is no cursor, overlay, or focus management to emulate. If you need keyboard-driven interaction, the web surface handles it for you and can host the same flows you once built in the TUI.

## Migrating existing extensions or tools
1. **Inventory your TUI hooks.** Search for `pi.ui.custom`, `ctx.ui.custom`, `CustomEditor`, `setEditorComponent`, or any dependency on `@mariozechner/pi-tui`. Those hooks no longer resolve at runtime.
2. **Port the experience to Bindery web.** Re-imagine the interaction as a card, modal, status row, or notification rendered by your extension via the web UI APIs (`ctx.ui.setWidget`, `ctx.ui.setFooter`, injectable cards/emulated overlays). The web workspace already supports Think/Cancel controls, branch navigation, and overlays without manual terminal rendering.
3. **Keep automation headless.** Use `pi --print`, `pi --mode json`, or RPC clients to drive background jobs. When automation needs to report progress, lean on `ctx.ui.notify()`, `ctx.ui.setStatus()`, or `ctx.ui.setWidget()`; those calls only publish structured data, they no longer draw in a terminal window.
4. **Update documentation/tests.** Remove references to TUI components in your docs, examples, and tests, and point readers to Bindery web or the headless APIs instead.

## Historical reference (keep for troubleshooting)
> The following details are preserved purely for teams that are migrating from the old TUI implementation and need to decode past examples. Do not use them to build new surfaces.

### Component interface (archival)
Each component originally implemented:

```ts
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;
}
```

### Focusable/IME support, overlays, and widgets

Focusable components had to propagate cursor markers, honor overlay options (size, anchor, visibility), manage `requestRender()`/`close()` lifecycles, and rebuild theme-aware caches after `invalidate()` was called. These requirements only applied to the terminal renderer and can be ignored when targeting Bindery web.

## Next steps for your project
- Point teammates and docs to Bindery web whenever you describe interactive control. Link to `pi.dev` or your self-hosted endpoint, note the bound session timeline, and describe how extensions place cards or widgets beside the assistant output.
- Use headless CLI flags (`--print`, `--mode json`, `--mode rpc`) or SDK calls when the work does not require direct user interaction.
- Treat this `docs/tui.md` page as historical context only; if you need a refresher on the old implementation, the source is available in upstream archives, but do not rebuild it for new interactive flows.
