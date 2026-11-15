// D-Bus contract between the companion app (app/) and the Shell extension.
// Shared by both sides; keep it free of Shell- and Gtk-specific imports.

export const APP_ID = 'io.github.WhatsGnome';
export const BUS_NAME = APP_ID;
export const OBJECT_PATH = '/io/github/WhatsGnome/Bridge';
export const IFACE_NAME = 'io.github.WhatsGnome.Bridge';

// State: "loading" | "login" (QR code shown) | "ready" | "offline"
// Chats: JSON array of {name, preview, unread, muted} (see app/lib/chats.js)
export const IFACE_XML = `
<node>
  <interface name="${IFACE_NAME}">
    <method name="Toggle"/>
    <method name="Show"/>
    <method name="Quit"/>
    <method name="OpenChat">
      <arg type="s" name="name" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="SendMessage">
      <arg type="s" name="name" direction="in"/>
      <arg type="s" name="text" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
    <property name="State" type="s" access="read"/>
    <property name="UnreadCount" type="u" access="read"/>
    <property name="Chats" type="s" access="read"/>
    <property name="Visible" type="b" access="read"/>
  </interface>
</node>`;
