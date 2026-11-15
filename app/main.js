// WhatsGnome companion app: hosts WhatsApp Web and serves the D-Bus bridge
// the Shell extension talks to. Run: gjs -m app/main.js [--background]
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import System from 'system';

import {APP_ID, IFACE_XML, OBJECT_PATH} from '../lib/dbus.js';
import {newMessages} from './lib/parse.js';

// Optional: without libgsound, notifications are silent.
let GSound = null;
try {
    GSound = (await import('gi://GSound')).default;
} catch {}

const SOUND_EVENT = 'message-new-instant'; // from the user's sound theme
const SOUND_MIN_INTERVAL_US = 2 * GLib.USEC_PER_SEC; // one sound per burst

function settingsOrNull(schemaId, path = null) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    if (!schema)
        return null;
    return new Gio.Settings({settings_schema: schema, ...(path ? {path} : {})});
}
import {WhatsAppWindow} from './window.js';

const WhatsGnomeApp = GObject.registerClass(
class WhatsGnomeApp extends Adw.Application {
    constructor() {
        super({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
        this._background = false;
        this._webNotifications = new Map(); // chat title -> WebKit.Notification
        this._notified = new Set(); // chat titles with a notification showing
        this._knownChats = null; // baseline for newMessages(); null until first chat list
        this._lastSound = 0;
        this.add_main_option('background', 'b'.charCodeAt(0), GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
            'Start hidden (e.g. at login)', null);
    }

    vfunc_handle_local_options(options) {
        this._background = options.contains('background');
        return -1;
    }

    vfunc_startup() {
        super.vfunc_startup();
        this.hold(); // keep running with the window hidden

        this._addAction('show', null, () => this.present());
        this._addAction('quit', null, () => this.quit());
        this._addAction('open-chat', 's', (_a, v) => this._onNotificationClicked(v.unpack()));
        this.set_accels_for_action('app.quit', ['<Control>q']);

        this._window = new WhatsAppWindow(this);
        for (const p of ['state', 'unread', 'chats-json'])
            this._window.connect(`notify::${p}`, () => this._emitChanged());
        this._window.connect('notify::visible', () => this._emitChanged());
        this._window.connect('notify::unread', () => {
            if (this._window.unread === 0)
                this._withdrawAll();
        });
        this._window.connect('web-notification', (_w, n) => this._onWebNotification(n));
        this._initSound();
        this._window.connect('notify::chats-json', () => this._onChatsChanged());
        this._window.connect('notify::state', () => {
            if (this._window.state !== 'ready')
                this._knownChats = null; // reload/logout: don't replay old unread chats
        });
    }

    vfunc_activate() {
        if (this._background) {
            this._background = false;
            return;
        }
        this.present();
    }

    vfunc_dbus_register(connection, path) {
        super.vfunc_dbus_register(connection, path);
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this._makeBridge());
        this._dbus.export(connection, OBJECT_PATH);
        return true;
    }

    vfunc_dbus_unregister(connection, path) {
        this._dbus?.unexport();
        this._dbus = null;
        super.vfunc_dbus_unregister(connection, path);
    }

    _addAction(name, type, cb) {
        const a = new Gio.SimpleAction({name, parameter_type: type ? new GLib.VariantType(type) : null});
        a.connect('activate', cb);
        this.add_action(a);
    }

    present() {
        this._window.present();
    }

    toggle() {
        const w = this._window;
        if (w.visible && w.is_active)
            w.close(); // hide_on_close
        else
            this.present();
    }

    _makeBridge() {
        const w = () => this._window;
        const reply = (invocation, promise) => promise
            .then(ok => invocation.return_value(new GLib.Variant('(b)', [Boolean(ok)])))
            .catch(e => {
                console.warn(`whatsgnome: ${e.message}`);
                invocation.return_value(new GLib.Variant('(b)', [false]));
            });
        return {
            Toggle: () => this.toggle(),
            Show: () => this.present(),
            Quit: () => this.quit(),
            OpenChatAsync: ([name], invocation) => {
                this.present();
                reply(invocation, w().openChat(name));
            },
            SendMessageAsync: ([name, text], invocation) => reply(invocation, w().sendMessage(name, text)),
            get State() {
                return w()?.state ?? 'loading';
            },
            get UnreadCount() {
                return w()?.unread ?? 0;
            },
            get Chats() {
                return w()?.chats_json ?? '[]';
            },
            get Visible() {
                return w()?.visible ?? false;
            },
        };
    }

    _emitChanged() {
        if (!this._dbus || !this._window)
            return;
        const w = this._window;
        const props = {
            State: new GLib.Variant('s', w.state),
            UnreadCount: new GLib.Variant('u', w.unread),
            Chats: new GLib.Variant('s', w.chats_json),
            Visible: new GLib.Variant('b', w.visible),
        };
        // One PropertiesChanged per change is fine at this rate; emit only what differs.
        this._last ??= {};
        for (const [k, v] of Object.entries(props)) {
            const s = v.print(false);
            if (this._last[k] !== s) {
                this._last[k] = s;
                this._dbus.emit_property_changed(k, v);
            }
        }
    }

    // WhatsApp Web sends its notifications from a service worker, and WebKitGTK
    // never delivers those to the app, so notify from the chat list instead:
    // a chat whose unread count goes up while the window isn't focused.
    _onChatsChanged() {
        let chats;
        try {
            chats = JSON.parse(this._window.chats_json);
        } catch {
            return;
        }
        const fresh = newMessages(this._knownChats, chats);
        this._knownChats = chats;
        for (const c of chats) {
            if (c.unread === 0 && this._notified.has(c.name))
                this._withdraw(c.name); // read elsewhere, e.g. on the phone
        }
        if (this._window.is_active)
            return; // like WhatsApp itself: no notifications while you're looking
        for (const c of fresh)
            this._notify(c.name, c.preview);
    }

    // Page-level web notifications, should WhatsApp send any. Same id per
    // chat as _onChatsChanged, so the two never show duplicates.
    _onWebNotification(n) {
        const title = n.title || 'WhatsApp';
        this._webNotifications.set(title, n);
        n.connect('closed', () => {
            if (this._webNotifications.get(title) === n)
                this._webNotifications.delete(title);
        });
        this._notify(title, n.body);
    }

    _notify(title, body) {
        const g = new Gio.Notification();
        g.set_title(title);
        if (body)
            g.set_body(body);
        g.set_category?.('im.received');
        g.set_default_action_and_target('app.open-chat', new GLib.Variant('s', title));
        this.send_notification(`chat:${title}`, g);
        this._notified.add(title);
        this._playSound();
    }

    // GNOME Shell only plays sounds for freedesktop notifications, not for
    // GNotification, so the app plays the theme's message sound itself.
    _initSound() {
        try {
            this._sound = GSound ? new GSound.Context() : null;
            this._sound?.init(null);
        } catch (e) {
            console.warn(`whatsgnome: no notification sound: ${e.message}`);
            this._sound = null;
        }
        const slug = APP_ID.toLowerCase().replaceAll('.', '-');
        this._notifySettings = settingsOrNull('org.gnome.desktop.notifications');
        this._appNotifySettings = settingsOrNull('org.gnome.desktop.notifications.application',
            `/org/gnome/desktop/notifications/application/${slug}/`);
        this._soundSettings = settingsOrNull('org.gnome.desktop.sound');
    }

    // Respects Do Not Disturb, the app's "Sound Alerts" switch in Settings ›
    // Notifications, and the system-wide alert sound setting.
    _soundAllowed() {
        return (this._notifySettings?.get_boolean('show-banners') ?? true) &&
            (this._appNotifySettings?.get_boolean('enable') ?? true) &&
            (this._appNotifySettings?.get_boolean('enable-sound-alerts') ?? true) &&
            (this._soundSettings?.get_boolean('event-sounds') ?? true);
    }

    _playSound() {
        const now = GLib.get_monotonic_time();
        if (!this._sound || now - this._lastSound < SOUND_MIN_INTERVAL_US || !this._soundAllowed())
            return;
        this._lastSound = now;
        try {
            this._sound.play_simple({
                [GSound.ATTR_EVENT_ID]: SOUND_EVENT,
                [GSound.ATTR_EVENT_DESCRIPTION]: 'New WhatsApp message',
            }, null);
        } catch (e) {
            console.warn(`whatsgnome: cannot play sound: ${e.message}`);
        }
    }

    _withdraw(title) {
        this.withdraw_notification(`chat:${title}`);
        this._notified.delete(title);
        this._webNotifications.delete(title);
    }

    _onNotificationClicked(title) {
        this.present();
        const n = this._webNotifications.get(title);
        this._withdraw(title);
        if (n)
            n.clicked(); // lets WhatsApp open the right chat itself
        else
            this._window.openChat(title).catch(() => {});
    }

    _withdrawAll() {
        for (const title of new Set([...this._notified, ...this._webNotifications.keys()]))
            this._withdraw(title);
    }
});

const app = new WhatsGnomeApp();
System.exit(await app.runAsync([System.programInvocationName, ...ARGV]));
