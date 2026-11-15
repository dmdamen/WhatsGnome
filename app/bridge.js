// Injected into web.whatsapp.com in an isolated script world ("whatsgnome"):
// it shares the DOM with the page but not its JavaScript globals.
//
// Reports {type:'state'} and {type:'chats'} messages to the app and exposes
// window.whatsgnome.{openChat,send} for the app to call.
//
// WhatsApp Web changes its markup regularly. All selectors live in SEL so a
// breakage is a one-place fix. Inspect with WHATSGNOME_DEBUG=1 ./dev run.
(() => {
    if (window.whatsgnome)
        return;

    const SEL = {
        chatList: '#pane-side',
        chatRow: '#pane-side [role="listitem"], #pane-side [role="row"]',
        rowTitles: 'span[title]',
        rowBadge: '[aria-label*="unread" i], span[data-testid="icon-unread-count"]',
        rowMuted: '[data-icon*="muted" i]',
        loginQr: 'canvas[aria-label], [data-ref]',
        mainHeaderTitle: '#main header span[title], #main header [dir="auto"]',
        composer: '#main footer [contenteditable="true"]',
        sendButton: '#main footer button[aria-label="Send"], #main footer [data-icon="send"], #main footer [data-icon*="send" i]',
        searchBox: '#side [contenteditable="true"]',
    };

    const post = msg => {
        try {
            window.webkit.messageHandlers.whatsgnome.postMessage(JSON.stringify(msg));
        } catch (e) {
            console.error('whatsgnome: postMessage failed', e);
        }
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function waitFor(fn, timeout = 4000) {
        const end = Date.now() + timeout;
        for (;;) {
            const v = fn();
            if (v)
                return v;
            if (Date.now() > end)
                return null;
            await sleep(100);
        }
    }

    function rowY(row) {
        // Rows are absolutely positioned: style="transform: translateY(144px)"
        for (let el = row; el && el.id !== 'pane-side'; el = el.parentElement) {
            const m = /translateY\((-?[\d.]+)px\)/.exec(el.style?.transform ?? '');
            if (m)
                return Number(m[1]);
        }
        return row.getBoundingClientRect().top;
    }

    function scrapeChats() {
        return [...document.querySelectorAll(SEL.chatRow)].map(row => {
            const titles = [...row.querySelectorAll(SEL.rowTitles)].map(s => s.getAttribute('title'));
            const badge = row.querySelector(SEL.rowBadge);
            return {
                name: titles[0] ?? '',
                preview: titles[1] ?? '',
                badge: badge ? badge.getAttribute('aria-label') || badge.textContent : null,
                muted: Boolean(row.querySelector(SEL.rowMuted)),
                y: rowY(row),
            };
        });
    }

    function detectState() {
        if (document.querySelector(SEL.chatList))
            return 'ready';
        if (document.querySelector(SEL.loginQr))
            return 'login';
        return 'loading';
    }

    let lastState = null, lastChats = null, timer = 0;
    function report() {
        timer = 0;
        const state = detectState();
        if (state !== lastState) {
            lastState = state;
            post({type: 'state', state});
        }
        if (state === 'ready') {
            const chats = JSON.stringify(scrapeChats());
            if (chats !== lastChats) {
                lastChats = chats;
                post({type: 'chats', rows: JSON.parse(chats)});
            }
        }
    }
    const schedule = () => {
        if (!timer)
            timer = setTimeout(report, 400);
    };

    function findRow(name) {
        for (const row of document.querySelectorAll(SEL.chatRow)) {
            const t = row.querySelector(SEL.rowTitles);
            if (t && t.getAttribute('title') === name)
                return row;
        }
        return null;
    }

    function click(el) {
        // WhatsApp's React handlers listen for mousedown, not just click.
        const target = el.querySelector('[role="gridcell"], [tabindex]') ?? el;
        const opts = {bubbles: true, cancelable: true, view: window, button: 0};
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
            target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, opts));
    }

    function currentChat() {
        const t = document.querySelector(SEL.mainHeaderTitle);
        return t ? t.getAttribute('title') || t.textContent : null;
    }

    async function openChat(name) {
        if (currentChat() === name && document.querySelector(SEL.composer))
            return true;
        const row = findRow(name);
        if (!row)
            return false;
        click(row);
        return Boolean(await waitFor(() => currentChat() === name && document.querySelector(SEL.composer)));
    }

    async function send(name, text) {
        if (!text || !await openChat(name))
            return false;
        const box = document.querySelector(SEL.composer);
        box.focus();
        // execCommand goes through the editor's input pipeline, so React sees it.
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        const btn = await waitFor(() => document.querySelector(SEL.sendButton)?.closest('button, [role="button"]') ??
            document.querySelector(SEL.sendButton), 2000);
        if (btn) {
            click(btn);
        } else {
            const ev = {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true};
            box.dispatchEvent(new KeyboardEvent('keydown', ev));
        }
        // Sent once the composer is empty again.
        return Boolean(await waitFor(() => !box.isConnected || !box.textContent.trim(), 3000));
    }

    window.whatsgnome = {openChat, send, refresh: () => { lastChats = null; report(); }};

    new MutationObserver(schedule).observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['title', 'aria-label', 'style'],
    });
    schedule();
})();
