// Smoke check run in the container: importing must not throw (syntax errors,
// wrong GI versions, bad GObject class definitions). No display is needed.
import System from 'system';
try {
    await import('../lib/dbus.js');
    await import('../lib/viewmodel.js');
    await import('../app/window.js');
    print('imports ok');
} catch (e) {
    print(`import failed: ${e}\n${e.stack}`);
    System.exit(1);
}
