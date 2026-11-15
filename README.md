# WhatsGnome

WhatsApp for GNOME, in two parts:

- **Companion app** (`app/`): a GJS + GTK 4 + WebKitGTK 6.0 window that runs WhatsApp Web, sends messages as native GNOME notifications, and exposes its state over D-Bus (`io.github.WhatsGnome`, see `lib/dbus.js`).
- **Shell extension** (repo root): a top-bar icon with an unread badge. **Left click** shows or hides the window. **Right click** opens the menu of recent chats, where each chat expands to a quick-reply field.

GNOME Shell can't host a web view, and WhatsApp has no API for personal accounts, so the app is required.

## Install

```sh
./dev install              # or: ./dev install --autostart  (starts hidden at login)
# log out and back in (Wayland), then:
gnome-extensions enable whatsgnome@dennis@damenmail.nl
```

`install` only writes files under `~/.local`: the extension symlink, a `.desktop` file (GNOME needs it to show notifications), and a D-Bus activation file. At runtime it uses the GNOME stack that's already installed (gjs, GTK 4, libadwaita, webkitgtk6.0).

Open WhatsGnome and scan the QR code with your phone. The session is stored in `~/.local/share/whatsgnome`.

## Development

All build and test tooling runs in podman. Nothing is installed on the host.

| Command | |
|---|---|
| `./dev test` | unit tests (`lib/`, `app/lib/`) |
| `./dev coverage` | tests with a coverage gate (95%) |
| `./dev check` | loads the app's GTK/WebKit modules headless to catch import and class errors |
| `./dev run` | runs the app in the foreground with the web inspector (Ctrl+Shift+I) |
| `./dev logs` | follows GNOME Shell's log |
| `./dev pack` | builds a zip |

### When WhatsApp Web changes

The chat list and quick reply work by scraping the page DOM. Every selector is in the `SEL` block at the top of `app/bridge.js`. If the chat list or sending stops working, run `./dev run`, inspect the page, and update `SEL`. The unread badge comes from the page title and notifications come from WebKit, so those two don't depend on selectors.

If WhatsApp says the browser is unsupported, set a newer Chrome user agent with `WHATSGNOME_UA=...`.
