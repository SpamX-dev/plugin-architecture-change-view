import { randomUUID } from "node:crypto";
import path from "node:path";
import { within } from "../../framework/project/paths.js";

interface Session {
  header: { id: string };
  append(type: string, data: Record<string, unknown>): void;
}
interface Message { content: { type: string; text?: string }[] }
interface Turn { agent: { session: Session }; turn: number; signal: AbortSignal }
interface Decision { kind: string; messages: Message[] }
interface Services {
  workingDirectory: { ensure(agent: Turn["agent"], signal: AbortSignal): Promise<string> };
  sandboxPolicy: { resolve(request: { session: Session }): unknown };
  shell: {
    resolve(request: {command: string; stdin: string; workdir: string; sandboxPolicy: unknown; signal: AbortSignal; timeoutMs: number}): unknown;
    execute(spec: unknown): Promise<{ result(): Promise<{ exitCode: number | null; stdout: {text: string}; stderr: {text: string} }> }>;
  };
  logger: { warn(message: string): void };
  on(point: "agent/pre-step", listener: (event: Turn & {messages: Message[]}, next: () => Promise<Decision>) => Promise<Decision>): void;
  on(point: "agent/turn-stopping", listener: (event: Turn) => Promise<void>): void;
}

export const name = "archiview-session-hooks";
export const inject = ["shell", "workingDirectory", "sandboxPolicy"];

/** The trusted profile supplies the command. DSH resolves its permissions for each session. */
export function apply(ctx: Services, config: { repository: string; command: string }) {
  if (!path.isAbsolute(config.repository) || !config.command?.trim()) throw new Error("Укажите абсолютный путь repository и команду ArchiView");
  async function run(point: "UserPromptSubmit" | "Stop", {agent, turn, signal}: Turn, prompt?: string) {
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    if (!within(config.repository, cwd)) return;
    const session = agent.session;
    const handlerId = "archiview:" + point;
    session.append("hook/invoked", {turn, point, dialect:"codex", handlerId});
    const start = performance.now();
    let exitCode: number | null = null;
    let diagnostic: string | undefined;
    try {
      const spec = ctx.shell.resolve({command:config.command, workdir:cwd, signal, timeoutMs:600_000,
        sandboxPolicy:ctx.sandboxPolicy.resolve({session}),
        stdin:JSON.stringify({hook_event_name:point, session_id:session.header.id, turn_id:String(turn), cwd, prompt})});
      const result = await (await ctx.shell.execute(spec)).result();
      exitCode = result.exitCode;
      if (exitCode !== 0) throw new Error(result.stderr.text.trim() || "Код завершения " + exitCode);
      const output = JSON.parse(result.stdout.text);
      if (typeof output.systemMessage === "string") ctx.logger.warn(output.systemMessage);
      if (point === "UserPromptSubmit" && output.hookSpecificOutput?.hookEventName === point &&
          typeof output.hookSpecificOutput.additionalContext === "string") return output.hookSpecificOutput.additionalContext as string;
    } catch (error) {
      diagnostic = "ArchiView: " + (error instanceof Error ? error.message : String(error));
      ctx.logger.warn(diagnostic);
      return diagnostic;
    } finally {
      session.append("hook/result", {turn, point, handlerId, decision:"pass", durationMs:performance.now() - start,
        ...(exitCode !== null && {exitCode}), ...(diagnostic && {stderrSummary:diagnostic.slice(0, 1000)})});
    }
  }

  ctx.on("agent/pre-step", async (event, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || !event.messages.length) return decision;
    const prompt = event.messages.flatMap(m => m.content).filter(b => b.type === "text").map(b => b.text).join("");
    const text = await run("UserPromptSubmit", event, prompt);
    if (!text) return decision;
    const context = {id:randomUUID(), role:"user", source:{kind:"archiview"}, content:[{type:"text", text}]};
    return {...decision, messages:[...decision.messages, context]};
  });
  ctx.on("agent/turn-stopping", async event => { await run("Stop", event); });
}
