import type { ArchiViewClient } from "./types.js";
import { createModulePresenter } from "./module-presenter/module-card.js";
import { openWorkspace } from "./workspace-presenter/workspace.js";

export function startApp(client: ArchiViewClient) {
  return openWorkspace(client, workspace => createModulePresenter(client, workspace));
}
