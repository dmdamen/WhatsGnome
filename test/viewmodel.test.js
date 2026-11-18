import {describe, it, expect} from './harness.js';
import {badgeText, buildViewModel, MAX_MENU_CHATS} from '../lib/viewmodel.js';

const chats = n => JSON.stringify(Array.from({length: n}, (_, i) => ({name: `c${i}`, preview: 'p', unread: i % 2, muted: false})));

describe('badgeText', () => {
    it('is empty for zero/negative', () => {
        expect(badgeText(0)).toBe('');
        expect(badgeText(-1)).toBe('');
        expect(badgeText(undefined)).toBe('');
    });
    it('shows the count', () => expect(badgeText(5)).toBe('5'));
    it('caps at 99+', () => expect(badgeText(100)).toBe('99+'));
});

describe('buildViewModel', () => {
    it('offline when the app is not running', () => {
        const vm = buildViewModel(false, {State: 'ready', UnreadCount: 3});
        expect(vm.running).toBe(false);
        expect(vm.badge).toBe('');
        expect(vm.chats).toEqual([]);
        expect(vm.status).toContain('not running');
    });
    it('asks to scan the QR code when logged out', () => {
        const vm = buildViewModel(true, {State: 'login', UnreadCount: 0, Chats: chats(3)});
        expect(vm.status).toContain('QR');
        expect(vm.chats).toEqual([]);
    });
    it('shows loading by default', () => expect(buildViewModel(true, {}).status).toContain('Loading'));
    it('shows unread count and chats when ready', () => {
        const vm = buildViewModel(true, {State: 'ready', UnreadCount: 2, Chats: chats(3)});
        expect(vm.badge).toBe('2');
        expect(vm.status).toBe('2 unread chats');
        expect(vm.chats.map(c => c.label)).toEqual(['c0', 'c1 (1)', 'c2']);
    });
    it('passes cached avatar files through', () => {
        const json = JSON.stringify([
            {name: 'a', avatar: '/home/u/.cache/whatsgnome/avatars/ab.jpg'},
            {name: 'b', avatar: ''},
            {name: 'c', avatar: 'https://pps.whatsapp.net/x.jpg'},
            {name: 'd', avatar: '/home/u/../../etc/x.jpg'},
            {name: 'e'},
        ]);
        expect(buildViewModel(true, {State: 'ready', Chats: json}).chats.map(c => c.avatar))
            .toEqual(['/home/u/.cache/whatsgnome/avatars/ab.jpg', '', '', '', '']);
    });
    it('uses singular for one chat', () =>
        expect(buildViewModel(true, {State: 'ready', UnreadCount: 1}).status).toBe('1 unread chat'));
    it('says so when nothing is unread', () =>
        expect(buildViewModel(true, {State: 'ready', UnreadCount: 0}).status).toBe('No unread messages'));
    it('limits menu chats', () =>
        expect(buildViewModel(true, {State: 'ready', Chats: chats(20)}).chats.length).toBe(MAX_MENU_CHATS));
    it('survives malformed chat JSON', () => {
        expect(buildViewModel(true, {State: 'ready', Chats: '{oops'}).chats).toEqual([]);
        expect(buildViewModel(true, {State: 'ready', Chats: '{"a":1}'}).chats).toEqual([]);
        expect(buildViewModel(true, {State: 'ready', Chats: '[null,{"x":1},{"name":"ok"}]'}).chats.map(c => c.name)).toEqual(['ok']);
    });
});
