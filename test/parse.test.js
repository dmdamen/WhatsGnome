import {describe, it, expect} from './harness.js';
import {avatarKey, isInternalUri, newMessages, normalizeChats, parseUnreadBadge, parseUnreadFromTitle, sameChats, MAX_PREVIEW} from '../app/lib/parse.js';

describe('parseUnreadFromTitle', () => {
    it('reads the count prefix', () => expect(parseUnreadFromTitle('(12) WhatsApp')).toBe(12));
    it('is 0 without a prefix', () => expect(parseUnreadFromTitle('WhatsApp')).toBe(0));
    it('handles null', () => expect(parseUnreadFromTitle(null)).toBe(0));
    it('ignores numbers elsewhere', () => expect(parseUnreadFromTitle('WhatsApp (3)')).toBe(0));
});

describe('parseUnreadBadge', () => {
    it('reads aria labels', () => expect(parseUnreadBadge('3 unread messages')).toBe(3));
    it('reads localised labels', () => expect(parseUnreadBadge('5 ongelezen berichten')).toBe(5));
    it('reads bare text', () => expect(parseUnreadBadge(' 7 ')).toBe(7));
    it('counts a numberless badge as 1', () => expect(parseUnreadBadge('Unread')).toBe(1));
    it('is 0 for missing badges', () => {
        expect(parseUnreadBadge(null)).toBe(0);
        expect(parseUnreadBadge(undefined)).toBe(0);
        expect(parseUnreadBadge('  ')).toBe(0);
    });
});

describe('normalizeChats', () => {
    const row = (name, y, extra = {}) => ({name, preview: `hi ${name}`, badge: null, muted: false, y, ...extra});

    it('sorts by visual position', () =>
        expect(normalizeChats([row('B', 72), row('A', 0), row('C', 144)]).map(c => c.name)).toEqual(['A', 'B', 'C']));
    it('keeps DOM order on equal y', () =>
        expect(normalizeChats([row('B', 0), row('A', 0)]).map(c => c.name)).toEqual(['B', 'A']));
    it('drops duplicates and nameless rows', () =>
        expect(normalizeChats([row('A', 0), row('', 10), row('A', 20), row('B', 30)]).map(c => c.name)).toEqual(['A', 'B']));
    it('limits the count', () =>
        expect(normalizeChats([row('A', 0), row('B', 1), row('C', 2)], 2).length).toBe(2));
    it('parses unread and muted', () =>
        expect(normalizeChats([row('A', 0, {badge: '2 unread messages', muted: 1})])[0])
            .toEqual({name: 'A', preview: 'hi A', unread: 2, muted: true, avatarUrl: ''}));
    it('keeps CDN avatar URLs only', () => {
        const cdn = 'https://media-ams2-1.cdn.whatsapp.net/v/t61/123_n.jpg?oh=x&oe=y';
        const [a, b] = normalizeChats([row('A', 0, {avatar: cdn}), row('B', 1, {avatar: 'data:image/gif;base64,R0lG'})]);
        expect(a.avatarUrl).toBe(cdn);
        expect(b.avatarUrl).toBe('');
    });
    it('strips direction marks and collapses whitespace', () =>
        expect(normalizeChats([row('‪Mom‬', 0, {preview: 'a \n  b'})])[0].preview).toBe('a b'));
    it('truncates long previews', () => {
        const p = normalizeChats([row('A', 0, {preview: 'x'.repeat(500)})])[0].preview;
        expect(p.length).toBe(MAX_PREVIEW);
        expect(p.endsWith('…')).toBeTruthy();
    });
    it('tolerates garbage', () => {
        expect(normalizeChats(null)).toEqual([]);
        expect(normalizeChats([null, 5, {}])).toEqual([]);
    });
});

describe('sameChats', () => {
    it('compares by value', () => {
        expect(sameChats([{name: 'a'}], [{name: 'a'}])).toBeTruthy();
        expect(sameChats([{name: 'a'}], [{name: 'b'}])).toBeFalsy();
    });
});

describe('isInternalUri', () => {
    it('allows WhatsApp Web', () => expect(isInternalUri('https://web.whatsapp.com/')).toBeTruthy());
    it('allows media hosts', () => expect(isInternalUri('https://mmg.whatsapp.net/x')).toBeTruthy());
    it('allows blob and data', () => {
        expect(isInternalUri('blob:https://web.whatsapp.com/123')).toBeTruthy();
        expect(isInternalUri('data:image/png;base64,AA')).toBeTruthy();
        expect(isInternalUri('about:blank')).toBeTruthy();
    });
    it('rejects other sites', () => {
        expect(isInternalUri('https://example.com/')).toBeFalsy();
        expect(isInternalUri('https://web.whatsapp.com.evil.com/')).toBeFalsy();
        expect(isInternalUri('https://evilwhatsapp.net/')).toBeFalsy();
        expect(isInternalUri('https://user@evil.com/web.whatsapp.com')).toBeFalsy();
    });
    it('rejects plain http and junk', () => {
        expect(isInternalUri('http://web.whatsapp.com/')).toBeFalsy();
        expect(isInternalUri('not a uri')).toBeFalsy();
        expect(isInternalUri(null)).toBeFalsy();
    });
});

describe('newMessages', () => {
    const chat = (name, unread, muted = false) => ({name, preview: `hi ${name}`, unread, muted});

    it('reports nothing without a baseline', () =>
        expect(newMessages(null, [chat('A', 3)])).toEqual([]));
    it('reports chats whose unread count went up', () =>
        expect(newMessages([chat('A', 0), chat('B', 1)], [chat('B', 2), chat('A', 0)]).map(c => c.name)).toEqual(['B']));
    it('reports chats that newly appear with unread messages', () =>
        expect(newMessages([chat('A', 0)], [chat('C', 1), chat('A', 0)]).map(c => c.name)).toEqual(['C']));
    it('skips muted chats', () =>
        expect(newMessages([chat('A', 0)], [chat('A', 4, true)])).toEqual([]));
    it('ignores chats being read', () =>
        expect(newMessages([chat('A', 2)], [chat('A', 0)])).toEqual([]));
    it('handles a bad list', () =>
        expect(newMessages([], null)).toEqual([]));
});

describe('avatarKey', () => {
    it('uses the path of CDN URLs', () =>
        expect(avatarKey('https://media-ams2-1.cdn.whatsapp.net/v/t61/123_n.jpg?oh=a&oe=b')).toBe('/v/t61/123_n.jpg'));
    it('ignores the signature', () =>
        expect(avatarKey('https://pps.whatsapp.net/v/1.jpg?oh=a')).toBe(avatarKey('https://pps.whatsapp.net/v/1.jpg?oh=b')));
    it('rejects other hosts and schemes', () => {
        expect(avatarKey('https://evil.example/v/1.jpg')).toBe(null);
        expect(avatarKey('https://whatsapp.net.evil.example/v/1.jpg')).toBe(null);
        expect(avatarKey('http://pps.whatsapp.net/v/1.jpg')).toBe(null);
        expect(avatarKey('data:image/gif;base64,R0lG')).toBe(null);
    });
    it('rejects empty paths and junk', () => {
        expect(avatarKey('https://pps.whatsapp.net/')).toBe(null);
        expect(avatarKey(null)).toBe(null);
    });
});
