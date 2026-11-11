/** The host services consumed by this adapter. Optional services are read lazily. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatRootOptions } from "./chat-root.js";
import type { loadSkill } from "./skill.js";
import type { clientConfigRow } from "./panel-contract.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Dispose = () => void;
export interface HostServices {
  skills: { register(skill: Awaited<ReturnType<typeof loadSkill>>): Dispose };
  sessions: NonNullable<ChatRootOptions["sessions"]>;
  sessionController: NonNullable<ChatRootOptions["sessionController"]>;
}
export interface HostContext {
  effect(register: () => Dispose, label: string): unknown;
  get<K extends keyof HostServices>(name: K): HostServices[K] | undefined;
  logger?: { warn?(text: string): void };
  tools: { register(tool: unknown): unknown };
  connection: { requestRejection(request: IncomingMessage): number | undefined };
  webServer: { register(route: { kind: string; path: string; handler(request: IncomingMessage, response: ServerResponse): unknown }): Dispose };
  on(event: "webserver/index-inject", callback: (rows: ReturnType<typeof clientConfigRow>[]) => void): Dispose;
}
export interface HostConfig {
  root: string;
  stateDirectory: string;
  prefix: string;
  maxFiles: number;
  extensions: string[];
  panel: boolean;
  tools: boolean;
  skill: boolean;
}
