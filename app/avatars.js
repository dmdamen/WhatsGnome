// Local copies of chat profile photos, so the Shell extension can show them
// from a file path (it can't fetch WhatsApp's signed CDN URLs itself).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {avatarKey} from './lib/parse.js';

const MAX_BYTES = 512 * 1024;
const PRUNE_AFTER_DAYS = 30;

export class AvatarCache {
    // onUpdate() runs after a photo finishes downloading.
    constructor(dir, onUpdate) {
        this._dir = dir;
        this._onUpdate = onUpdate;
        this._pending = new Set();
        this._failed = new Set(); // don't retry a broken URL every scrape
        this._session = new Soup.Session({timeout: 20});
        GLib.mkdir_with_parents(dir, 0o700);
        this._prune();
    }

    // The cached file for a photo URL, or '' (and a download starts) if it
    // isn't cached yet. Files are named after the URL's path, which only
    // changes when the photo does; the Shell caches images by file name.
    lookup(url) {
        const key = avatarKey(url);
        if (!key)
            return '';
        const path = GLib.build_filenamev([this._dir,
            `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1)}.jpg`]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
        if (!this._pending.has(path) && !this._failed.has(key))
            this._download(url, key, path);
        return '';
    }

    _download(url, key, path) {
        this._pending.add(path);
        const msg = Soup.Message.new('GET', url);
        this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (session, res) => {
            this._pending.delete(path);
            try {
                const bytes = session.send_and_read_finish(res);
                const [type] = msg.get_response_headers().get_content_type();
                if (msg.get_status() !== Soup.Status.OK || !type?.startsWith('image/') ||
                    bytes.get_size() > MAX_BYTES)
                    throw new Error(`HTTP ${msg.get_status()} ${type} ${bytes.get_size()} bytes`);
                // replace_contents writes to a temp file and renames: never a partial image.
                Gio.File.new_for_path(path).replace_contents(bytes.toArray(), null, false,
                    Gio.FileCreateFlags.PRIVATE, null);
                this._onUpdate();
            } catch (e) {
                this._failed.add(key);
                console.warn(`whatsgnome: avatar download failed: ${e.message}`);
            }
        });
    }

    // Old photos pile up as contacts change theirs; drop files not touched in a
    // while. A photo still in use is simply downloaded again.
    _prune() {
        const cutoff = GLib.get_real_time() / GLib.USEC_PER_SEC - PRUNE_AFTER_DAYS * 86400;
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const en = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                if (info.get_attribute_uint64('time::modified') < cutoff)
                    dir.get_child(info.get_name()).delete(null);
            }
        } catch (e) {
            console.warn(`whatsgnome: cannot prune avatars: ${e.message}`);
        }
    }
}
