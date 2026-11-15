// Discovers test/**/*.test.js, runs them, and exits non-zero on failure.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {run} from './harness.js';

const testDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

function findTests(dir) {
    const out = [];
    const en = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type', 0, null);
    let info;
    while ((info = en.next_file(null))) {
        const path = GLib.build_filenamev([dir, info.get_name()]);
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            out.push(...findTests(path));
        else if (path.endsWith('.test.js'))
            out.push(path);
    }
    return out.sort();
}

const loop = new GLib.MainLoop(null, false);
let failed = 1;
(async () => {
    try {
        for (const path of findTests(testDir))
            await import(`file://${path}`);
        failed = await run();
    } catch (e) {
        print(`Fatal: ${e}\n${e.stack}`);
    } finally {
        loop.quit();
    }
})();
loop.run();
System.exit(failed ? 1 : 0);
