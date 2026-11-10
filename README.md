# Zulip Desktop Client

[![Build Status](https://github.com/zulip/zulip-desktop/actions/workflows/node.js.yml/badge.svg)](https://github.com/zulip/zulip-desktop/actions/workflows/node.js.yml?query=branch%3Amain)
[![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)
[![project chat](https://img.shields.io/badge/zulip-join_chat-brightgreen.svg)](https://chat.zulip.org)

Desktop client for Zulip. Available for Mac, Linux, and Windows.

![screenshot](./docs/images/zulip-desktop-screenshot-light.webp)
![screenshot](./docs/images/zulip-desktop-screenshot-dark.webp)

## Download

Please see the [installation guide](https://zulip.com/help/desktop-app-install-guide).

## Features

- Sign in to multiple organizations
- Desktop notifications with inline reply
- Tray/dock integration
- Multi-language spell checker
- Automatic updates
- Recent downloads panel: opens when a download completes and can be reopened
  from **View > Recent Downloads**. Click a filename to open the saved file, or
  use the folder icon to reveal it in the file manager. Download history is kept
  across restarts.
- Markdown attachments in chat have an eye icon (**Preview Markdown**) beside their
  download link. Clicking it downloads the file using your normal download
  settings and opens the rendered Markdown preview. Download errors appear
  beside the button; the original link still downloads normally.

### Styling downloads

The downloads panel and Markdown preview use compact 12px text. Upload a CSS
file in **Settings > General** to customize them as well as the chat views.
Reopen the panel or preview to apply changes to the uploaded file.

Markdown previews have no application menu. Zoom with **Ctrl + mouse wheel**
or **Ctrl + plus/minus**, and reset with **Ctrl + 0** (use **Cmd** for keyboard
shortcuts on macOS). The mouse wheel without Ctrl scrolls normally.
Web links in Markdown previews open in your system's default browser rather
than navigating away from the preview.

Panel styling hooks: `.downloads-panel`, `.downloads-header`,
`.downloads-heading`, `.downloads-close`, `.downloads-list`, `.downloads-empty`,
`.downloads-error`, `.download-row`, `.download-file`, `.preview-download`, and
`.reveal-download`, and `.download-icon`. Preview hooks: `.downloads-preview` (the page body) and
`.downloads-preview-content` (the rendered Markdown).

For example:

```css
.downloads-panel,
.downloads-preview {
  font-size: 11px;
}

.downloads-panel .download-file {
  color: steelblue;
}

.downloads-preview-content table {
  font-size: 10px;
}
```

## Reporting issues

This desktop client shares most of its code with the Zulip web app.
Issues in an individual organization's Zulip window should be reported
in the [Zulip server and web app
project](https://github.com/zulip/zulip/issues/new). Other
issues in the desktop app and its settings should be reported [in this
project](https://github.com/zulip/zulip-desktop/issues/new).

## Contribute

First, join us on the [Zulip community server](https://zulip.readthedocs.io/en/latest/contributing/chat-zulip-org.html)!
Also see our [contribution guidelines](./CONTRIBUTING.md) and our [development guide](./development.md).

## License

Released under the [Apache-2.0](./LICENSE) license.
