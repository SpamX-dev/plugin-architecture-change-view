import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { HarnessOption } from "../../../module-operations/analysis-record.js";
import { ApplicationError } from "../../../module-operations/errors.js";

export type HarnessKind = "codex" | "dsh";
export interface ProjectTarget { repositoryRoot: string; workspaceRoot: string }
export interface Assignment extends ProjectTarget { requestId: string; moduleId: string; prompt: string }
export interface Adapter {
  kind: HarnessKind;
  instance: string;
  available(target: ProjectTarget): Promise<string | undefined>;
  start(job: Assignment): Promise<string>;
}

interface Registration { id: string; kind: HarnessKind; instance: string; token: string; pid: number }
const names = { codex: "Codex", dsh: "DeepSeek Harness" };
const idPattern = /^[a-f0-9-]{36}$/;
export const bridgeDirectory = () => process.env.ARCHIVIEW_BRIDGE_DIR || path.join(homedir(), ".archiview", "harnesses");
const endpoint = (id: string) => process.platform === "win32" ? "\\\\.\\pipe\\archiview-" + id : unixEndpoint(id);

function unixEndpoint(id: string) {
  const file = "archiview-" + id + ".sock";
  const address = path.join(tmpdir(), file);
  return Buffer.byteLength(address) < 103 ? address : path.join("/tmp", file);
}

async function message(stream: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("Слишком большой запрос моста");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function harnessInstanceId(kind: HarnessKind, instance: string) {
  return kind + "-" + createHash("sha256").update(instance).digest("hex").slice(0, 24);
}

/** The private directory supplies the capability. The browser only sees a logical harness ID. */
export async function registerHarness(adapter: Adapter) {
  const folder = bridgeDirectory();
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const token = randomBytes(32).toString("hex");
  const registration: Registration = { id, kind: adapter.kind, token, pid: process.pid,
    instance: harnessInstanceId(adapter.kind, adapter.instance) };
  const file = path.join(folder, id + ".json");
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.headers.authorization !== "Bearer " + token ||
          (req.url !== "/probe" && req.url !== "/start")) {
        res.writeHead(403).end();
        return;
      }
      const input = await message(req);
      if (!input || typeof input.repositoryRoot !== "string" || !path.isAbsolute(input.repositoryRoot) ||
          typeof input.workspaceRoot !== "string" || !path.isAbsolute(input.workspaceRoot)) throw new Error("Некорректная рабочая папка");
      if (req.url === "/probe") res.end(JSON.stringify({ id, reason: await adapter.available(input) }));
      else {
        if (typeof input.requestId !== "string" || !idPattern.test(input.requestId) || typeof input.moduleId !== "string" ||
            typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("Некорректное поручение");
        const chatId = await adapter.start(input);
        if (!chatId) throw new Error("Хост не вернул идентификатор чата");
        res.end(JSON.stringify({ id, chatId }));
      }
    } catch (error) {
      res.writeHead(502).end(JSON.stringify({ error: error instanceof Error ? error.message : "Ошибка harness" }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint(id), resolve); });
  try { await writeFile(file, JSON.stringify(registration), { mode: 0o600, flag: "wx" }); }
  catch (error) { server.close(); throw error; }
  return async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([closed, rm(file, { force: true })]);
  };
}

async function registrations(): Promise<Registration[]> {
  const folder = bridgeDirectory();
  let files: string[];
  try { files = await readdir(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const entries = await Promise.all(files.filter(file => idPattern.test(path.basename(file, ".json")) && file.endsWith(".json")).map(async file => {
    const target = path.join(folder, file);
    try {
      const row = JSON.parse(await readFile(target, "utf8")) as Registration;
      if (!row || row.id + ".json" !== file || !(row.kind === "codex" || row.kind === "dsh") ||
          typeof row.token !== "string" || typeof row.instance !== "string" || !Number.isSafeInteger(row.pid) || row.pid <= 0) return;
      try { process.kill(row.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { await rm(target, { force: true }); return; } }
      return row;
    } catch { /* A plugin can unregister while the directory is being read. */ }
  }));
  return entries.filter((entry): entry is Registration => !!entry);
}

function call(row: Registration, route: "/probe" | "/start", input: ProjectTarget | Assignment) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const req = request({ socketPath: endpoint(row.id), path: route, method: "POST", agent: false,
      signal: AbortSignal.timeout(route === "/probe" ? 3500 : 60000),
      headers: { authorization: "Bearer " + row.token, "content-type": "application/json" } }, res => {
      message(res).then(result => {
        if (res.statusCode !== 200 || result?.id !== row.id) throw new Error(result?.error || "Мост отклонил запрос");
        resolve(result);
      }).catch(reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(input));
  });
}

async function probe(target: ProjectTarget, instance?: string) {
  const entries = (await registrations()).filter(row => !instance || row.instance === instance);
  const result = await Promise.all(entries.map(async row => {
    try {
      const response = await call(row, "/probe", target);
      return { row, reason: typeof response.reason === "string" ? response.reason : undefined };
    } catch { return undefined; }
  }));
  return result.filter(entry => entry !== undefined);
}

export async function listHarnesses(target: ProjectTarget): Promise<{ harnesses: HarnessOption[] }> {
  const options = new Map<string, HarnessOption>();
  for (const { row, reason } of await probe(target)) {
    if (!options.has(row.instance) || !reason) options.set(row.instance, { id: row.instance, name: names[row.kind], reason });
  }
  return { harnesses: [...options.values()].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
}

/** Resolve the live endpoint before claiming a delivery. Never fail over after /start. */
export async function connectHarness(instance: string, target: ProjectTarget) {
  const candidates = await probe(target, instance);
  const live = candidates.find(entry => !entry.reason);
  if (!live) throw new ApplicationError("HARNESS_UNAVAILABLE", candidates[0]?.reason || "Выбранный harness отключился");
  return { name: names[live.row.kind], async start(job: Assignment) {
    const response = await call(live.row, "/start", job);
    if (typeof response.chatId !== "string" || !response.chatId) throw new Error("Хост не подтвердил создание чата");
    return response.chatId;
  } };
}
