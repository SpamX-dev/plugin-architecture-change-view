import type { ComponentType } from "react";

export type SendPrompt = (sessionId: string, text: string) => Promise<void>;
export interface PanelProps { sessionId?: string; sendPrompt?: SendPrompt }
type Dispose = () => void;
export interface PromptContext {
  get(name: "sessions"): {
    retain(id: string, options: { source: string }): {
      ready: Promise<{ session: { prompt(content: { type: "text"; text: string }[], mode: "queue"): Promise<{ ok: boolean; error?: { message?: string } }> } }>;
      release(): void;
    };
  } | undefined;
}
export interface ClientContext extends PromptContext {
  effect(register: () => Dispose, label: string): unknown;
  sidebarRightTabs: { register(definition: { id: string; kind: string; priority: string; title(): string; guide: { id: string; order: number; title(): string; description(): string }[] }): Dispose };
  slots: {
    inject(name: string, register: () => Dispose): Dispose;
    register(slot: { name: string; key: string }, body: ComponentType<PanelProps>): Dispose;
  };
}
