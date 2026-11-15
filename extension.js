// GNOME Shell glue: mirrors the companion app's D-Bus state in the top bar.
// Logic lives in lib/ (unit tested); this file only renders and wires events.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {APP_ID, BUS_NAME, IFACE_XML, OBJECT_PATH} from './lib/dbus.js';
import {buildViewModel} from './lib/viewmodel.js';

const BridgeProxy = Gio.DBusProxy.makeProxyWrapper(IFACE_XML);

// Module state survives disable/enable (e.g. screen lock), so the app is only
// autostarted once per session and stays quit if the user quits it.
let autostarted = false;

// GNOME 48 replaced St.BoxLayout:vertical with :orientation (51 removed it).
function vbox(params) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

// The user's double-click time in ms (Clutter.Settings moved onto the context).
function doubleClickTime() {
    const settings = global.stage.context?.get_settings?.() ?? Clutter.Settings.get_default();
    return settings.double_click_time;
}

// Reports every press with its button. ClickGesture can't be used: it ignores
// a second press that falls inside the double-click time.
const PanelPress = GObject.registerClass({
    Signals: {'pressed': {param_types: [GObject.TYPE_UINT]}},
}, class PanelPress extends Clutter.PressGesture {
    vfunc_press() {
        this.emit('pressed', this.get_button());
    }
});

const ReplyItem = GObject.registerClass(
class ReplyItem extends PopupMenu.PopupBaseMenuItem {
    _init(onSend) {
        super._init({reactive: false, can_focus: false});
        const box = vbox({x_expand: true});
        this.entry = new St.Entry({hint_text: 'Reply…', can_focus: true, x_expand: true, style_class: 'whatsgnome-reply'});
        this._status = new St.Label({style_class: 'whatsgnome-reply-status', visible: false});
        box.add_child(this.entry);
        box.add_child(this._status);
        this.add_child(box);
        this.entry.clutter_text.connect('activate', async () => {
            const text = this.entry.get_text().trim();
            if (!text)
                return;
            this.entry.reactive = false;
            this._setStatus('Sending…');
            const ok = await onSend(text);
            this.entry.reactive = true;
            if (ok) {
                this.entry.set_text('');
                this._setStatus('Sent');
            } else {
                this._setStatus('Could not send; open the chat in WhatsApp');
            }
        });
    }

    _setStatus(text) {
        this._status.text = text;
        this._status.visible = Boolean(text);
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'WhatsGnome');
        this._ext = ext;
        this._vm = null;
        this._dirty = false;

        // The badge overlaps the icon's top-right corner. Overlay it with a
        // BinLayout: St reads negative CSS margins as unsigned, which made the
        // badge ~4 billion px wide and broke the whole panel's layout.
        const box = new St.Widget({
            style_class: 'whatsgnome-icon-box',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            gicon: Gio.FileIcon.new(ext.dir.resolve_relative_path('icons/whatsgnome-symbolic.svg')),
            style_class: 'system-status-icon whatsgnome-icon',
        });
        this._badge = new St.Label({
            style_class: 'whatsgnome-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._badge);
        this.add_child(box);

        // A click (any button, or touch) toggles the menu; a double left click
        // shows WhatsApp. GNOME 51 opens the menu from its own ClickGesture;
        // swap it for ours. Older shells go through vfunc_event below.
        if (this._clickGesture) {
            this._clickGesture.enabled = false;
            this._routedClick = new PanelPress();
            this._routedClick.connect('pressed', (_g, button) => this._onPress(button));
            this.add_action(this._routedClick);
        }

        this._clickTimeoutId = 0;
        this.connect('destroy', () => this._cancelPendingClick());

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open || this._dirty)
                this._rebuildMenu();
        });
    }

    // A left click waits out the double-click time before opening the menu:
    // once the menu is open its grab swallows the next press, so a double
    // click could not be seen. Other buttons and touch open it right away.
    _onPress(button) {
        if (button !== Clutter.BUTTON_PRIMARY) {
            this._cancelPendingClick();
            this.menu.toggle();
        } else if (this._clickTimeoutId) {
            this._cancelPendingClick();
            this._ext.showWindow();
        } else {
            this._clickTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, doubleClickTime(), () => {
                this._clickTimeoutId = 0;
                this.menu.toggle();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _cancelPendingClick() {
        if (this._clickTimeoutId)
            GLib.source_remove(this._clickTimeoutId);
        this._clickTimeoutId = 0;
    }

    vfunc_event(event) {
        // GNOME 51+: input is handled by gestures and there is no parent
        // vfunc_event to chain up to (calling it throws on every event).
        if (this._routedClick)
            return Clutter.EVENT_PROPAGATE;
        if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            this._onPress(event.get_button());
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    update(vm) {
        this._vm = vm;
        this._badge.text = vm.badge;
        this._badge.visible = Boolean(vm.badge);
        if (vm.badge)
            this.add_style_class_name('whatsgnome-badged');
        else
            this.remove_style_class_name('whatsgnome-badged');
        if (vm.running)
            this.remove_style_class_name('whatsgnome-offline');
        else
            this.add_style_class_name('whatsgnome-offline');
        // Rebuilding destroys a reply entry the user may be typing in.
        if (this.menu.isOpen)
            this._dirty = true;
        else
            this._rebuildMenu();
    }

    _rebuildMenu() {
        this._dirty = false;
        const vm = this._vm;
        this.menu.removeAll();
        if (!vm)
            return;

        const status = new PopupMenu.PopupMenuItem(vm.status, {reactive: false});
        status.label.add_style_class_name('whatsgnome-status');
        this.menu.addMenuItem(status);

        if (vm.chats.length)
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Recent chats'));
        for (const chat of vm.chats)
            this.menu.addMenuItem(this._chatItem(chat));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (vm.running) {
            this.menu.addAction('Show WhatsApp', () => this._ext.call('Show'));
            this.menu.addAction('Quit WhatsApp', () => this._ext.call('Quit'));
        } else {
            this.menu.addAction('Start WhatsApp', () => this._ext.launchApp(false));
        }
    }

    _chatItem(chat) {
        const item = new PopupMenu.PopupSubMenuMenuItem(chat.label);
        if (chat.unread)
            item.label.add_style_class_name('whatsgnome-unread');
        if (chat.muted)
            item.add_style_class_name('whatsgnome-muted');

        if (chat.preview) {
            const preview = new PopupMenu.PopupMenuItem(chat.preview, {reactive: false});
            preview.label.add_style_class_name('whatsgnome-preview');
            preview.label.clutter_text.line_wrap = true;
            item.menu.addMenuItem(preview);
        }
        const reply = new ReplyItem(text => this._ext.sendMessage(chat.name, text));
        item.menu.addMenuItem(reply);
        item.menu.addAction('Open chat', () => this._ext.call('OpenChat', chat.name));
        item.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    reply.entry.grab_key_focus();
                    return GLib.SOURCE_REMOVE;
                });
        });
        return item;
    }
});

export default class WhatsGnomeExtension extends Extension {
    enable() {
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._refresh();
        this._watch = Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._onAppeared(), () => this._onVanished());
        if (!autostarted) {
            autostarted = true;
            this._startInBackground();
        }
    }

    // Starts the app hidden via D-Bus activation (the service file from
    // `./dev install`), falling back to running it directly. A no-op if it's
    // already running.
    _startInBackground() {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'StartServiceByName', new GLib.Variant('(su)', [BUS_NAME, 0]),
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this.launchApp(true);
                }
            });
    }

    disable() {
        Gio.bus_unwatch_name(this._watch);
        this._cancellable.cancel();
        this._dropProxy();
        this._indicator?.destroy();
        this._indicator = null;
    }

    async _onAppeared() {
        this._dropProxy();
        try {
            const proxy = await BridgeProxy.newAsync(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
                this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
            if (!this._indicator)
                return;
            this._proxy = proxy;
            this._propsId = proxy.connect('g-properties-changed', () => this._refresh());
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`WhatsGnome: cannot connect to app: ${e.message}`);
        }
        this._refresh();
    }

    _onVanished() {
        this._dropProxy();
        this._refresh();
    }

    _dropProxy() {
        if (this._proxy && this._propsId)
            this._proxy.disconnect(this._propsId);
        this._proxy = null;
        this._propsId = 0;
    }

    _refresh() {
        const p = this._proxy;
        const running = Boolean(p?.g_name_owner);
        const vm = buildViewModel(running, running ? {State: p.State, UnreadCount: p.UnreadCount, Chats: p.Chats} : {});
        this._indicator?.update(vm);
    }

    // Prefer the installed .desktop file (needed for notifications); fall back
    // to running the bundled app directly.
    launchApp(background) {
        const app = Shell.AppSystem.get_default().lookup_app(`${APP_ID}.desktop`);
        if (app && !background) {
            app.activate();
            return;
        }
        const argv = ['gjs', '-m', this.dir.get_child('app').get_child('main.js').get_path()];
        if (background)
            argv.push('--background');
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notifyError('WhatsGnome', `Could not start the app: ${e.message}`);
        }
    }

    showWindow() {
        if (this._proxy?.g_name_owner)
            this.call('Show');
        else
            this.launchApp(false);
    }

    async call(method, ...args) {
        if (!this._proxy)
            return null;
        try {
            return await this._proxy[`${method}Async`](...args);
        } catch (e) {
            console.warn(`WhatsGnome: ${method} failed: ${e.message}`);
            return null;
        }
    }

    async sendMessage(name, text) {
        const res = await this.call('SendMessage', name, text);
        return Boolean(res?.[0]);
    }
}
