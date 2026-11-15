import {describe, it, expect} from './harness.js';
import {isInternalUri, normalizeChats, parseUnreadBadge, parseUnreadFromTitle, sameChats, MAX_PREVIEW} from '../app/lib/parse.js';

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
            .toEqual({name: 'A', preview: 'hi A', unread: 2, muted: true}));
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
