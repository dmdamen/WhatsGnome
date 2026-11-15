// WhatsGnome companion app: hosts WhatsApp Web and serves the D-Bus bridge
// the Shell extension talks to. Run: gjs -m app/main.js [--background]
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import System from 'system';

import {APP_ID, IFACE_XML, OBJECT_PATH} from '../lib/dbus.js';
import {WhatsAppWindow} from './window.js';

const WhatsGnomeApp = GObject.registerClass(
class WhatsGnomeApp extends Adw.Application {
    constructor() {
        super({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
        this._background = false;
        this._webNotifications = new Map(); // chat title -> WebKit.Notification
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

    // WhatsApp Web only notifies while unfocused; forward to GNOME as native notifications.
    _onWebNotification(n) {
        const title = n.title || 'WhatsApp';
        this._webNotifications.set(title, n);
        n.connect('closed', () => {
            if (this._webNotifications.get(title) === n)
                this._webNotifications.delete(title);
        });
        const g = new Gio.Notification();
        g.set_title(title);
        if (n.body)
            g.set_body(n.body);
        g.set_category?.('im.received');
        g.set_default_action_and_target_value('app.open-chat', new GLib.Variant('s', title));
        this.send_notification(`chat:${title}`, g);
    }

    _onNotificationClicked(title) {
        this.present();
        this.withdraw_notification(`chat:${title}`);
        const n = this._webNotifications.get(title);
        if (n)
            n.clicked(); // lets WhatsApp open the right chat itself
        else
            this._window.openChat(title).catch(() => {});
    }

    _withdrawAll() {
        for (const title of this._webNotifications.keys())
            this.withdraw_notification(`chat:${title}`);
        this._webNotifications.clear();
    }
});

const app = new WhatsGnomeApp();
System.exit(await app.runAsync([System.programInvocationName, ...ARGV]));
