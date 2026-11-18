// Turns the D-Bus state into what the panel button and menu should show.
// Pure: no Shell imports, unit tested.

export const MAX_MENU_CHATS = 8;

// Avatars are files the app cached; anything else on the bus is ignored.
function avatarPath(a) {
    return typeof a === 'string' && a.startsWith('/') && a.endsWith('.jpg') && !a.includes('/../') ? a : '';
}

export function badgeText(n) {
    if (!n || n < 0)
        return '';
    return n > 99 ? '99+' : String(n);
}

function parseChats(json) {
    if (!json)
        return [];
    try {
        const v = JSON.parse(json);
        return Array.isArray(v) ? v.filter(c => c && typeof c.name === 'string') : [];
    } catch {
        return [];
    }
}

// running: whether the companion app owns its bus name.
// props: {State, UnreadCount, Chats} as read from the D-Bus proxy.
export function buildViewModel(running, props = {}) {
    if (!running) {
        return {
            running: false, state: 'offline', badge: '', status: 'WhatsApp is not running',
            chats: [], canQuit: false,
        };
    }
    const state = props.State || 'loading';
    const unread = Number(props.UnreadCount) || 0;
    const chats = parseChats(props.Chats).slice(0, MAX_MENU_CHATS).map(c => ({
        name: c.name,
        preview: c.preview ?? '',
        unread: Number(c.unread) || 0,
        muted: Boolean(c.muted),
        avatar: avatarPath(c.avatar),
        label: c.unread ? `${c.name} (${c.unread})` : c.name,
    }));
    let status;
    if (state === 'login')
        status = 'Scan the QR code to link your phone';
    else if (state === 'ready')
        status = unread ? `${unread} unread chat${unread === 1 ? '' : 's'}` : 'No unread messages';
    else
        status = 'Loading WhatsApp…';
    return {
        running: true, state, badge: state === 'ready' ? badgeText(unread) : '', status,
        chats: state === 'ready' ? chats : [], canQuit: true,
    };
}
