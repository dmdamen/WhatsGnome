// The WhatsApp Web window: a persistent WebKit view plus the bridge script.
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';

import {AvatarCache} from './avatars.js';
import {isInternalUri, normalizeChats, parseUnreadFromTitle, sameChats} from './lib/parse.js';

const URL = 'https://web.whatsapp.com/';
const WORLD = 'whatsgnome';
// WhatsApp Web refuses browsers it does not recognise. Override with WHATSGNOME_UA.
const USER_AGENT = GLib.getenv('WHATSGNOME_UA') ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const MAX_CHATS = 10;

const appDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

function readFile(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes);
}

function dataDir(kind) {
    const base = kind === 'cache' ? GLib.get_user_cache_dir() : GLib.get_user_data_dir();
    const dir = GLib.build_filenamev([base, 'whatsgnome']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

function openExternally(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, null, null, (_o, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res);
        } catch (e) {
            console.warn(`whatsgnome: cannot open ${uri}: ${e.message}`);
        }
    });
}

export const WhatsAppWindow = GObject.registerClass({
    Properties: {
        'state': GObject.ParamSpec.string('state', null, null, GObject.ParamFlags.READABLE, 'loading'),
        'unread': GObject.ParamSpec.uint('unread', null, null, GObject.ParamFlags.READABLE, 0, 0xffffffff, 0),
        'chats-json': GObject.ParamSpec.string('chats-json', null, null, GObject.ParamFlags.READABLE, '[]'),
    },
    Signals: {
        'web-notification': {param_types: [WebKit.Notification.$gtype]},
    },
}, class WhatsAppWindow extends Adw.ApplicationWindow {
    constructor(app) {
        super({application: app, title: 'WhatsApp', default_width: 1100, default_height: 800, hide_on_close: true});
        this._state = 'loading';
        this._unread = 0;
        this._chats = []; // published over D-Bus: {name, preview, unread, muted, avatar}
        this._scrapedChats = []; // as scraped, with avatarUrl instead of avatar
        this._avatars = new AvatarCache(GLib.build_filenamev([dataDir('cache'), 'avatars']),
            () => this._publishChats());

        const session = WebKit.NetworkSession.new(dataDir('data'), dataDir('cache'));
        session.connect('download-started', (_s, download) => this._onDownload(download));

        const ucm = new WebKit.UserContentManager();
        ucm.register_script_message_handler(WORLD, WORLD);
        ucm.connect(`script-message-received::${WORLD}`, (_m, value) => this._onBridgeMessage(value));
        ucm.add_script(WebKit.UserScript.new_for_world(
            readFile(GLib.build_filenamev([appDir, 'bridge.js'])),
            WebKit.UserContentInjectedFrames.TOP_FRAME, WebKit.UserScriptInjectionTime.END,
            WORLD, null, null));

        const debug = Boolean(GLib.getenv('WHATSGNOME_DEBUG'));
        const settings = new WebKit.Settings({
            user_agent: USER_AGENT,
            enable_developer_extras: debug,
            enable_media_stream: true,
            enable_webrtc: true,
        });

        // WebKitGTK forgets granted notification permission on every restart,
        // and WhatsApp only asks again when you click its "turn on desktop
        // notifications" banner, so messages arrived silently. Grant it up front
        // (must be connected before the web process starts).
        WebKit.WebContext.get_default().connect('initialize-notification-permissions', ctx =>
            ctx.initialize_notification_permissions([WebKit.SecurityOrigin.new_for_uri(URL)], []));

        this._web = new WebKit.WebView({
            network_session: session, user_content_manager: ucm, settings,
            vexpand: true, hexpand: true,
        });
        WebKit.WebContext.get_default().set_spell_checking_enabled(true);

        this._web.connect('notify::title', () => this._setUnread(parseUnreadFromTitle(this._web.title)));
        this._web.connect('permission-request', (_w, req) => this._onPermission(req));
        this._web.connect('show-notification', (_w, n) => {
            this.emit('web-notification', n);
            return true;
        });
        this._web.connect('decide-policy', (_w, decision, type) => this._onPolicy(decision, type));
        this._web.connect('web-process-terminated', () => this._web.reload());
        this._web.connect('load-changed', (_w, ev) => {
            if (ev === WebKit.LoadEvent.STARTED)
                this._setState('loading');
        });

        const view = new Adw.ToolbarView({content: this._web});
        view.add_top_bar(new Adw.HeaderBar({show_title: false}));
        view.top_bar_style = Adw.ToolbarStyle.FLAT;
        this.content = view;

        const keys = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.MANAGED});
        keys.add_shortcut(new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('<Control>r|F5'),
            action: Gtk.CallbackAction.new(() => { this._web.reload(); return true; }),
        }));
        if (debug) {
            keys.add_shortcut(new Gtk.Shortcut({
                trigger: Gtk.ShortcutTrigger.parse_string('<Control><Shift>i'),
                action: Gtk.CallbackAction.new(() => { this._web.get_inspector().show(); return true; }),
            }));
        }
        this.add_controller(keys);

        this._web.load_uri(URL);
    }

    get state() {
        return this._state;
    }

    get unread() {
        return this._unread;
    }

    get chats_json() {
        return JSON.stringify(this._chats);
    }

    _setState(s) {
        if (s !== this._state) {
            this._state = s;
            this.notify('state');
        }
    }

    _setUnread(n) {
        if (n !== this._unread) {
            this._unread = n;
            this.notify('unread');
        }
    }

    // Swaps each photo URL for its cached file ('' until downloaded). Signed
    // URLs change on their own, so comparing after the swap avoids churn.
    _publishChats() {
        const chats = this._scrapedChats.map(({avatarUrl, ...c}) => ({...c, avatar: this._avatars.lookup(avatarUrl)}));
        if (!sameChats(chats, this._chats)) {
            this._chats = chats;
            this.notify('chats-json');
        }
    }

    _onBridgeMessage(value) {
        let msg;
        try {
            msg = JSON.parse(value.to_string());
        } catch (e) {
            console.warn(`whatsgnome: bad bridge message: ${e.message}`);
            return;
        }
        if (msg.type === 'state') {
            this._setState(msg.state);
        } else if (msg.type === 'chats') {
            this._scrapedChats = normalizeChats(msg.rows, MAX_CHATS);
            this._publishChats();
        } else if (msg.type === 'log') {
            console.warn(`whatsgnome: ${msg.text}`);
        }
    }

    _onPermission(req) {
        // Notifications, plus mic/camera for voice notes and calls. The view only
        // ever hosts web.whatsapp.com (see _onPolicy).
        if (req instanceof WebKit.NotificationPermissionRequest ||
            req instanceof WebKit.UserMediaPermissionRequest ||
            req instanceof WebKit.ClipboardPermissionRequest) {
            req.allow();
            return true;
        }
        return false;
    }

    _onPolicy(decision, type) {
        if (type !== WebKit.PolicyDecisionType.NAVIGATION_ACTION &&
            type !== WebKit.PolicyDecisionType.NEW_WINDOW_ACTION)
            return false;
        const action = decision.get_navigation_action();
        const uri = action.get_request().get_uri();
        if (type === WebKit.PolicyDecisionType.NAVIGATION_ACTION &&
            (isInternalUri(uri) || !action.is_user_gesture()))
            return false; // page/subframe loads; only clicked links leave the app
        decision.ignore();
        if (/^(https?|mailto|tel):/i.test(uri))
            openExternally(uri);
        return true;
    }

    _onDownload(download) {
        download.connect('decide-destination', (dl, suggested) => {
            const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) || GLib.get_home_dir();
            dl.set_allow_overwrite(false);
            dl.set_destination(GLib.build_filenamev([dir, GLib.path_get_basename(suggested || 'download')]));
            return true;
        });
    }

    async _call(fn, args) {
        const variant = new GLib.Variant('a{sv}', Object.fromEntries(
            Object.entries(args).map(([k, v]) => [k, new GLib.Variant('s', v)])));
        const result = await new Promise((resolve, reject) => {
            this._web.call_async_javascript_function(
                `return await window.whatsgnome.${fn}(${Object.keys(args).join(', ')});`,
                -1, variant, WORLD, null, null, (w, res) => {
                    try {
                        resolve(w.call_async_javascript_function_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        return result.to_boolean();
    }

    openChat(name) {
        return this._call('openChat', {name});
    }

    sendMessage(name, text) {
        return this._call('send', {name, text});
    }
});
