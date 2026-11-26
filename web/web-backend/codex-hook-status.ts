import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ReviewSettings } from "../../module-operations/api.js";

type Status = NonNullable<ReviewSettings["codexStatus"]>;
interface ListedHook { sourcePath: string; eventName: string; command: string; enabled: boolean; trustStatus: string }

/** Query Codex's own hook registry. Reading the project file cannot establish trust. */
export function codexHookStatus(root: string, command: string): Promise<Status> {
  return new Promise(resolve => {
    const child = spawn("codex", ["app-server"], { cwd: homedir(), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({input: child.stdout});
    const timer = setTimeout(() => finish("unknown"), 4000);
    let done = false;
    function finish(status: Status) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      resolve(status);
    }
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
    child.once("error", () => finish("unknown"));
    child.once("close", () => finish("unknown"));
    child.stdin.on("error", () => finish("unknown"));
    lines.on("line", line => {
      try {
        const reply = JSON.parse(line);
        if (reply.id === 1 && reply.result) {
          send({method:"initialized"});
          send({id:2, method:"hooks/list", params:{cwds:[root]}});
        } else if (reply.id === 2) {
          const entry = reply.result?.data?.find((item: {cwd: string}) => path.relative(item.cwd, root) === "");
          const file = path.join(root, ".codex", "hooks.json");
          const hooks: ListedHook[] = (entry?.hooks ?? []).filter((h: ListedHook) =>
            h.command === command && typeof h.sourcePath === "string" && path.relative(h.sourcePath, file) === "");
          if (!["userPromptSubmit", "stop"].every(event => hooks.some(h => h.eventName === event))) return finish("unknown");
          if (hooks.some(h => h.trustStatus === "untrusted" || h.trustStatus === "modified")) return finish("needsTrust");
          if (hooks.some(h => !h.enabled)) return finish("disabled");
          finish(hooks.every(h => h.trustStatus === "trusted" || h.trustStatus === "managed") ? "trusted" : "unknown");
        } else if (reply.error) finish("unknown");
      } catch { finish("unknown"); }
    });
    send({id:1, method:"initialize", params:{clientInfo:{name:"archiview", version:"1"}, capabilities:{experimentalApi:true}}});
  });
}
