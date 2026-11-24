import { startApp } from "./app.js";
import { createArchiViewClient } from "./archiview-client/client.js";

await startApp(createArchiViewClient());
