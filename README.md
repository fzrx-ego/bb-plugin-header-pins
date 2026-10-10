# Header Pins

BB plugin that shows your pinned threads as chips in the empty title bar strip of the BB window.

- Click a chip to open the thread; the open thread's chip is highlighted.
- A dot shows the most urgent state across the thread and its children: yellow waits for you, blue works, green finished unread.
- A colored bar uses the thread's project color from [Chat Sidebar](https://github.com/seoperin/bb-plugin-chat-sidebar) by [Evgeniy Perin](https://github.com/seoperin) when it is installed, and the provider's color otherwise. We recommend using the two together.
- Hover a chip to unpin it.

See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for the full description.

## Requirements

BB 0.46 or later, desktop app (tested on macOS). No account, keys or network access.

## Development

```sh
npm install
npm run typecheck
bb plugin build .
bb plugin install .
```

The chips are an `experimental_appOverlay` positioned over `[data-testid="app-window-title-bar"]`. That selector, and the Chat Sidebar row markup used for colors (`[data-chat-row]`, `.chat-stripe`), are not public API: check them after a BB update.

## License

MIT
