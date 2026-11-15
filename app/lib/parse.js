// Pure helpers that turn raw data scraped from WhatsApp Web into the clean
// values published over D-Bus. No GI imports, so this is unit tested.

export const MAX_PREVIEW = 120;

// WhatsApp Web sets the document title to "(3) WhatsApp" when there are unread chats.
export function parseUnreadFromTitle(title) {
    const m = /^\s*\((\d+)\)/.exec(title ?? '');
    return m ? Number(m[1]) : 0;
}

// The unread badge is exposed as an aria-label like "3 unread messages" (in
// the user's UI language) or just its text "3". Any leading integer counts;
// a badge with no number (a "marked as unread" dot) counts as 1.
export function parseUnreadBadge(label) {
    if (label === null || label === undefined)
        return 0;
    const s = String(label).trim();
    if (!s)
        return 0;
    const m = /\d+/.exec(s);
    return m ? Number(m[0]) : 1;
}

function clean(s) {
    return String(s ?? '').replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// rows: [{name, preview, badge, muted, y}] as posted by app/bridge.js.
// The chat list is virtualised and positioned with transforms, so DOM order
// is not visual order: sort by y, then drop duplicates and nameless rows.
export function normalizeChats(rows, limit = 10) {
    if (!Array.isArray(rows))
        return [];
    const seen = new Set();
    const out = [];
    const sorted = rows
        .map((r, i) => ({r, i}))
        .sort((a, b) => (a.r?.y ?? 0) - (b.r?.y ?? 0) || a.i - b.i);
    for (const {r} of sorted) {
        const name = clean(r?.name);
        if (!name || seen.has(name))
            continue;
        seen.add(name);
        out.push({
            name,
            preview: truncate(clean(r.preview), MAX_PREVIEW),
            unread: parseUnreadBadge(r.badge),
            muted: Boolean(r.muted),
        });
        if (out.length >= limit)
            break;
    }
    return out;
}

export function sameChats(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Only keep the page's own origin in the WebView; everything else is a link
// the user clicked and belongs in their browser.
export function isInternalUri(uri) {
    const s = String(uri ?? '');
    if (s === 'about:blank' || /^(blob|data):/i.test(s))
        return true;
    const m = /^https:\/\/([^/?#:@]+)(?::\d+)?(?:[/?#]|$)/i.exec(s);
    if (!m)
        return false;
    const host = m[1].toLowerCase();
    return host === 'web.whatsapp.com' || host.endsWith('.whatsapp.net');
}

// Chats that got new unread messages between two chat lists, skipping muted
// ones. WhatsApp Web shows its notifications from a service worker, which
// WebKitGTK never hands to the app, so the app derives them from the chat list.
// prev === null means no baseline yet (first load): report nothing.
export function newMessages(prev, next) {
    if (!prev || !Array.isArray(next))
        return [];
    const before = new Map(prev.map(c => [c.name, c.unread]));
    return next.filter(c => !c.muted && c.unread > (before.get(c.name) ?? 0));
}
