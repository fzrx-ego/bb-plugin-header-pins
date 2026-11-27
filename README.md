# Header Pins

BB plugin that shows your pinned threads as tabs in each thread header, in place of the title and its adjacent actions menu.

- Click a chip to open the thread; the open thread's chip is highlighted.
- A dot shows the most urgent state across the thread and its children: yellow waits for you, blue works, green finished unread.
- A colored bar uses the thread's project color from [Chat Sidebar](https://github.com/seoperin/bb-plugin-chat-sidebar) by [Evgeniy Perin](https://github.com/seoperin) when it is installed, and the provider's color otherwise. We recommend using the two together.
- Hover a chip to unpin it.
- A floating capsule over the top of the conversation names the open thread, like a chat header in Telegram: provider icon on the project color, status dot, title, then project, model with reasoning level as the composer writes it ("6.2-Sol High"), branch and what the thread is doing or when it last changed. A second capsule holds quick buttons: by default New subthread and Mark finished from Chat Sidebar, pin or unpin, and the thread actions menu. Right-click the main capsule for the same menu.
- Choose the capsule's buttons and its second line in Settings → Plugins → Header Pins: any thread menu action without a submenu, the pin button, the menu, and the project, model, branch and status parts. The choice is kept in this browser's storage.

See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for the full description.

## Requirements

BB 0.50.1 or later with Plugin SDK 0.6.157 or later. No account, keys or network access.

## Development

```sh
npm install
npm run typecheck
bb plugin build .
bb plugin install .
```

The tabs use `experimental_threadHeaderTitle`, including in split panes. The capsule uses `experimental_threadHeaderRow`: a zero-height row whose content floats over the timeline. Its stylesheet raises `[data-thread-header-rows]` above the timeline; check that selector after a BB update. A lifecycle-managed content script expands the title slot and hides the adjacent actions menu only while Header Pins is rendered. Other header controls stay available. When tabs overflow, scroll horizontally. Thread actions are in the floating capsule.

Project stripes and the capsule use Chat Sidebar's saved color picks and its MIT-licensed color resolver in `vendor/`, fed the same projects as Chat Sidebar: those with active threads, most recently used first, with sub-threads counted under their root. They do not depend on which thread rows are visible.

The shell layout selector `[data-testid="app-page-header-content-row"]` and Chat Sidebar's `chat-sidebar/project-colors` storage key and color resolver are private integration contracts: check them after an update. The sidebar row selector `[data-chat-row]` is used only to reveal a thread after navigation. The default capsule buttons name Chat Sidebar's thread action keys `chat-sidebar/new-subthread` and `chat-sidebar/park`; without them the capsule simply leaves those buttons out.

## License

MIT
