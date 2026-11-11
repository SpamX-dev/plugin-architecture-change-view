import { startApp } from "../../web/archiview/app.js";
import { connectCodexPanel } from "./panel-bridge.js";
import { choosePanelProject, createArchiViewClient } from "./panel-client.js";

const bridge = connectCodexPanel();
const client = createArchiViewClient({ mode: "mcp", connection: bridge });
const pickerAvailable = document.querySelector<HTMLMetaElement>('meta[name="archiview-directory-picker"]')?.content === "true";
await startApp({ client, bridge, host: "codex", chooseProject: pickerAvailable ? () => choosePanelProject(bridge) : undefined });
