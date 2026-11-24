import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import { directImportEdges } from "../analyse/module-relations/graph.js";
import { commitTestFiles, contractYaml, initTestRepository, writeModuleTree } from "./support.js";

test("a standalone distribution builds both directions, retains snapshot source and refuses stale rebuilds", async t => {
  const temp = await mkdtemp(path.join(await realpath(tmpdir()), "archiview-relations-"));
  t.after(() => rm(temp, {recursive:true, force:true, maxRetries:4}));
  const root = path.join(temp, "project"), distribution = path.join(temp, "package");
  await mkdir(path.join(root, "lib"), {recursive:true});
  initTestRepository(root);
  await writeModuleTree(root, { app: ".", library: "lib" });
  for (const id of ["app","library"]) await writeFile(path.join(root, ".archiview/modules", id + ".yaml"), contractYaml(id));
  await writeFile(path.join(root, "package.json"), '{"name":"demo","type":"module"}');
  await writeFile(path.join(root, "lib/service.js"), "export function run() { return 42; }\n");
  const source = 'import { run as execute } from "./lib/service.js";\nexecute();\n';
  await writeFile(path.join(root, "main.js"), source);
  commitTestFiles(root);
  const git = promisify(execFile);
  const revision = (await git("git", ["rev-parse", "HEAD"], {cwd:root})).stdout.trim();
  await mkdir(distribution);
  for (const file of ["cli.mjs","package.json","scip","web"]) await cp(path.join("dist",file),path.join(distribution,file),{recursive:true});
  const cli = async (...args: string[]) => JSON.parse((await git(process.execPath, [path.join(distribution, "cli.mjs"), "--root",root,...args])).stdout);
  assert.deepEqual(await cli("--module-relations", "library"), {ready:false});
  const built = await cli("--build-relations");
  assert.equal(built.indexed, 2);
  const workspace = await createWorkspaceSession({root});
  t.after(() => workspace.close());
  const view = await workspace.getComparison();
  const args = {view:view.id, path:"lib"};
  const relations = await workspace.getRelations(args);
  assert.ok(relations.ready);
  assert.equal(relations.outgoing.length, 0);
  assert.equal(relations.incoming.length, 1);
  const usages = relations.incoming[0].symbols.find(symbol => symbol.definition.file === "lib/service.js" && symbol.uses.some(u=>u.line===2));
  assert.ok(usages?.uses.some(u=>u.text==="execute();"));
  const outgoing = await workspace.getRelations({view:view.id,path:"."});
  assert.ok(outgoing.ready);
  assert.equal(outgoing.outgoing[0].count, relations.incoming[0].count);
  await assert.rejects(readFile(path.join(root, "tsconfig.json")), {code:"ENOENT"});
  await writeFile(path.join(root, "main.js"), "export const replacement = 1;\n");
  await assert.rejects(workspace.buildRelations(args), {code:"STALE_VIEW"});
  const changed = await workspace.getComparison();
  assert.equal((await workspace.getRelations({view:changed.id,path:"lib"})).ready,false);
  const history = await workspace.getComparison({target:"git-"+revision});
  const historical = {view:history.id,path:"."};
  assert.equal((await workspace.getRelations(historical)).ready,true);
  assert.equal((await workspace.getRelationSource({...historical,file:"main.js"})).text,source);
  await assert.rejects(workspace.buildRelations(historical), {code:"INVALID_ARGUMENT"});
  const next = await workspace.buildRelations({view:changed.id,path:"lib"});
  assert.ok(next.ready);
  assert.deepEqual(next.incoming,[]);
});

test("imports stop at the facade in both directions, including aliases and exposed types", async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archiview-direct-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 4 }));
  initTestRepository(root);
  const modules = { consumer: ".", api: "api", framework: "framework", direct: "direct" };
  await writeModuleTree(root, modules);
  for (const [id, dir] of Object.entries(modules)) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, ".archiview/modules", id + ".yaml"), contractYaml(id));
  }
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
  await writeFile(path.join(root, "tsconfig.app.json"), JSON.stringify({
    compilerOptions: { module: "preserve", allowJs: true, paths: { "@api": ["./api/index.ts"], "@setup": ["./framework/setup.ts"] } },
  }));
  await writeFile(path.join(root, "framework/model.ts"), "export interface Model { complete: boolean }\nexport const value = 1;\n");
  await writeFile(path.join(root, "api/index.ts"),
    "export type { Model } from '../framework/model';\nexport * as nested from '../framework/model';\n");
  await writeFile(path.join(root, "consume.ts"),
    "import type { Model } from '@api';\nimport { nested } from '@api';\nexport const read = (m: Model) => m.complete && nested.value;\n");
  await writeFile(path.join(root, "direct/load.ts"), "export const load = () => import('../framework/model');\n");
  await writeFile(path.join(root, "framework/setup.ts"), "console.log('initialized');\n");
  await writeFile(path.join(root, "direct/start.ts"), "import '@setup';\n");
  await writeFile(path.join(root, "direct/common.cjs"), "module.exports = require('../api/index');\n");
  commitTestFiles(root);
  const ws = await createWorkspaceSession({ root });
  t.after(() => ws.close());
  const view = (await ws.getComparison()).id;
  async function neighbors(directory: string) {
    const data = await ws.getRelations({ view, path: directory });
    assert.ok(data.ready);
    return { incoming: data.incoming.map(p => p.directory).sort(), outgoing: data.outgoing.map(p => p.directory).sort() };
  }
  await ws.buildRelations({ view, path: "." });
  assert.deepEqual(await neighbors("."), { incoming: [], outgoing: ["api"] });
  assert.deepEqual(await neighbors("api"), { incoming: [".", "direct"], outgoing: ["framework"] });
  assert.deepEqual(await neighbors("framework"), { incoming: ["api", "direct"], outgoing: [] });
  const details = await ws.getRelations({ view, path: "direct" });
  assert.ok(details.ready);
  const uses = details.outgoing.find(peer => peer.directory === "framework")!.symbols.flatMap(s => s.uses.map(u => u.file));
  assert.ok(uses.includes("direct/start.ts"));
  assert.ok(uses.includes("direct/load.ts"));
});

test("old symbol evidence identifies direct imports using the saved source", async () => {
  const sources = { "a.ts": "import { nested } from './b';\nnested.value;\n" };
  const symbol = (file: string, id: string, line: number, column: number) => ({
    id, name: file, definition: { file, line: 1, column: 1 }, uses: [{ file: "a.ts", line, column }],
  });
  const edges = [
    { from: "a", to: "b", symbols: [symbol("b.ts", "pkg b.ts/", 1, 24)] },
    { from: "a", to: "c", symbols: [symbol("c.ts", "pkg c.ts/", 1, 10), symbol("c.ts", "pkg c.ts/value.", 2, 8)] },
  ];
  assert.deepEqual(await directImportEdges(edges, sources), [edges[0]]);
});
