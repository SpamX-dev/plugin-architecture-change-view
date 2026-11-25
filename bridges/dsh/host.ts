import path from "node:path";
import { registerHarness, type Adapter, type ProjectTarget } from "../../web/web-backend/host-bridge/channel.js";

interface Workspace { id: string; path: string }
interface Services {
  workspaceRegistry: { list(): Workspace[] };
  sessionController: {
    create(request: { sessionId: string; workspaceId?: string; cwd?: string }): Promise<{ sessionId: string }>;
    prompt(request: { requestId: string; sessionId: string; mode: "queue"; content: { type: "text"; text: string }[] },
      signal: AbortSignal): Promise<{ accepted: boolean }>;
  };
}

export function dshAdapter(ctx: Services): Adapter {
  function workspace(target: ProjectTarget) {
    const projects = ctx.workspaceRegistry.list();
    for (const root of [target.repositoryRoot, target.workspaceRoot]) {
      const found = projects.find(project => path.relative(project.path, root) === "");
      if (found) return found;
    }
  }
  return {
    kind: "dsh", instance: String(process.pid),
    async available() { return undefined; },
    async start(job) {
      const project = workspace(job);
      const { sessionId } = await ctx.sessionController.create({ sessionId: "session-" + job.requestId,
        ...(project ? { workspaceId: project.id } : { cwd: job.repositoryRoot }) });
      const receipt = await ctx.sessionController.prompt({ requestId: job.requestId, sessionId, mode: "queue",
        content: [{ type: "text", text: job.prompt }] }, AbortSignal.timeout(45000));
      if (!receipt.accepted) throw new Error("DeepSeek Harness отклонил поручение");
      return sessionId;
    },
  };
}

export const name = "archiview-harness";
export const inject = ["workspaceRegistry", "sessionController"];
export function apply(ctx: Services & { effect(setup: () => () => void, label: string): unknown; logger?: {warn(message: string): void} }) {
  ctx.effect(() => {
    const registration = registerHarness(dshAdapter(ctx));
    void registration.catch(error => ctx.logger?.warn(String(error)));
    return () => { void registration.then(close => close()).catch(error => ctx.logger?.warn(String(error))); };
  }, "archiview-harness");
}
