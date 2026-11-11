import { startApp } from "./app.js";
import { createArchiViewClient } from "./client.js";
import { connectPanel } from "./panel-bridge.js";

const panelBase = document.querySelector<HTMLMetaElement>('meta[name="archiview-base"]');
const host = panelBase ? "dsh" : "web";
const bridge = connectPanel(host);
const base = panelBase?.content ?? "";
const sessionId = document.querySelector<HTMLMetaElement>('meta[name="archiview-session"]')?.content ?? "";
const client = createArchiViewClient({ mode: "http", connection: bridge, base, sessionId });
await startApp({ client, bridge, host });
