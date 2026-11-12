/** Assertions at protocol boundaries keep fixtures explicit without weakening application types. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
export type { ComparisonView as ComparisonResponse, ModuleDetail as ModuleResponse } from "../src/application/api.js";

export async function writeModuleTree(root: string, directories: Record<string, string>) {
  await mkdir(path.join(root, ".archiview/modules"), { recursive: true });
  await writeFile(path.join(root, ".archiview/modules.tree"), stringify(directories));
}

export function contractYaml(id: string, purpose = "Read project data.") {
  return stringify({ schema_version: 1, id, title: id, kind: "module", purpose,
    responsibilities: { R1: purpose }, boundaries: {}, invariants: {} });
}

function record(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
}
export function uiData<T = Record<string, unknown>>(result: unknown): T {
  record(result);
  assert.deepEqual(result.content, []);
  assert.equal(result.structuredContent, undefined);
  record(result._meta);
  if (result.isError) {
    record(result._meta.error);
    assert.equal(typeof result._meta.error.message, "string");
    throw Object.assign(new Error(result._meta.error.message as string), { code: result._meta.error.code });
  }
  return result._meta.result as T;
}
export interface PanelMetadata {
  ui: { visibility: string[]; resourceUri: string; csp: { connectDomains: string[]; resourceDomains: string[] } };
  "openai/ui": { entrypoints: { type: string }[] };
}
export function panelMetadata(value: { _meta?: Record<string, unknown> }): PanelMetadata {
  record(value._meta);
  return value._meta as unknown as PanelMetadata;
}
export function processEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string,string] => entry[1] !== undefined));
}
export function firstTextContent(result: unknown): string {
  record(result);
  assert.ok(Array.isArray(result.content));
  const first: unknown = result.content[0];
  record(first);
  assert.equal(typeof first.text, "string");
  return first.text as string;
}
export function structuredData<T = Record<string, unknown>>(result: unknown): T {
  record(result);
  record(result.structuredContent);
  return result.structuredContent as T;
}
