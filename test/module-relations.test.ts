import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import { directImportEdges } from "../analyse/module-relations/graph.js";
import { GitTreeReader } from "../analyse/git-changes/git-tree.js";
import { rebuildRelationGraph, readRelationGraph } from "../analyse/module-relations/store.js";
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
  const cli = async (...args: string[]) => JSON.parse((await git(process.execPath,
    [path.join(distribution, "cli.mjs"), "--root", root, ...args], { cwd: root, windowsHide: true })).stdout);
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

test("JSDoc type imports link to their named module and ordinary comments and strings create no edges", async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archiview-jsdoc-"));
  t.after(() => rm(root, {recursive:true, force:true, maxRetries:4}));
  initTestRepository(root);
  for (const dir of ["based", "api", "tag", "inline", "prose"]) await mkdir(path.join(root, dir));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { allowJs:true, checkJs:true, module:"preserve", paths:{"@shape": ["./api/model.ts"]} },
  }));
  await writeFile(path.join(root, "based/type.ts"), "export interface Shape { area: number }");
  await writeFile(path.join(root, "api/model.ts"), 'export type { Shape } from "../based/type";');
  const tag = '/** @import { Shape } from "../api/model" */';
  const inline = '/** @typedef {import("@shape").Shape} Shape */';
  for (const [dir, declaration] of [["tag", tag], ["inline", inline]]) {
    await writeFile(path.join(root, dir, "use.js"), declaration + "\n/** @type {Shape} */\nexport const sample = { area: 1 };");
  }
  await writeFile(path.join(root, "prose/example.js"), [
    '// @import { Shape } from "../api/model"',
    'export const documentation = \'@typedef {import("@shape").Shape} Shape\';',
    'export const localCall = require => require("../api/model");',
    '/** @import { Absent } from "../nosuch/model" */',
    'export const unrelated = true;',
  ].join("\n"));
  const snapshot = await new GitTreeReader(root, root).working(null);
  const graph = await rebuildRelationGraph(root, undefined, snapshot);
  assert.deepEqual(graph.edges.map(e => [e.from, e.to]).sort(), [["api", "based"], ["inline", "api"], ["tag", "api"]]);
  for (const [dir, declaration] of [["tag", tag], ["inline", inline]]) {
    const file = dir + "/use.js";
    const symbol = graph.edges.find(e => e.from === dir)!.symbols.find(s => s.id.endsWith("/"));
    assert.equal(symbol?.definition.file, "api/model.ts");
    assert.deepEqual(symbol?.uses, [{ file, line:1, column:declaration.indexOf('"') + 1 }]);
    assert.equal(graph.sources[file].split("\n")[0], declaration);
  }
  const saved = path.join(root, ".archiview/snapshots/relations");
  const [filename] = await readdir(saved);
  await writeFile(path.join(saved, filename), JSON.stringify({...graph, version:4}));
  assert.equal(await readRelationGraph(root, undefined, snapshot), null);
  assert.equal((await readRelationGraph(root, undefined, {...snapshot, kind:"saved"}))?.version, 4);
});

test("conditional package imports follow the resolution mode of each JSDoc and TypeScript literal", async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archiview-resolution-mode-"));
  t.after(() => rm(root, {recursive:true, force:true, maxRetries:4}));
  initTestRepository(root);
  const files = {
    "package.json": JSON.stringify({ name:"fixture", type:"commonjs", imports: {
      "#shape": {import:"./esm/model.mjs", require:"./cjs/model.cjs"},
    } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: {allowJs:true, checkJs:true, module:"NodeNext", types:[]} }),
    "esm/model.mts": "export interface Shape { esm: boolean }",
    "cjs/model.cts": "export interface Shape { cjs: boolean }",
    "tags/read.cjs": [
      '/** @import { Shape as Imported } from "#shape" with { "resolution-mode": "import" } */',
      '/** @import { Shape as Required } from "#shape" */',
      '/** @type {Imported} */ exports.first = {esm:true};',
      '/** @type {Required} */ exports.second = {cjs:true};',
    ].join("\n"),
    "inline/read.cjs": [
      '/** @typedef {import("#shape", {with: {"resolution-mode": "import"}}).Shape} Imported */',
      '/** @typedef {import("#shape").Shape} Required */',
      '/** @type {Imported} */ exports.first = {esm:true};',
      '/** @type {Required} */ exports.second = {cjs:true};',
    ].join("\n"),
    "reverse/read.mjs": [
      '/** @typedef {import("#shape", {with: {"resolution-mode": "require"}}).Shape} Required */',
      '/** @typedef {import("#shape").Shape} Imported */',
      '/** @type {Required} */ export const first = {cjs:true};',
      '/** @type {Imported} */ export const second = {esm:true};',
    ].join("\n"),
    "typed/read.cts": 'export type S = import("#shape", {with: {"resolution-mode": "import"}}).Shape;',
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root,file)), {recursive:true});
    await writeFile(path.join(root,file), text);
  }
  const graph = await rebuildRelationGraph(root, undefined, await new GitTreeReader(root, root).working(null));
  const direct = graph.edges.flatMap(edge => edge.symbols.filter(symbol => symbol.id.endsWith("/"))
    .flatMap(symbol => symbol.uses.map(use => [use.file, use.line, symbol.definition.file])));
  assert.deepEqual(direct.sort(), [
    ["inline/read.cjs",1,"esm/model.mts"], ["inline/read.cjs",2,"cjs/model.cts"],
    ["reverse/read.mjs",1,"cjs/model.cts"], ["reverse/read.mjs",2,"esm/model.mts"],
    ["tags/read.cjs",1,"esm/model.mts"], ["tags/read.cjs",2,"cjs/model.cts"],
    ["typed/read.cts",1,"esm/model.mts"],
  ]);
});

test("literal runtime imports preserve their mode through TS wrappers and verified createRequire bindings", async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archiview-loader-"));
  t.after(() => rm(root, {recursive:true, force:true, maxRetries:4}));
  initTestRepository(root);
  const files = {
    "package.json": JSON.stringify({type:"module", imports:{"#entry":{import:"./esm/core.mjs", require:"./common/core.cjs"}}}),
    "tsconfig.json": JSON.stringify({compilerOptions:{module:"NodeNext", allowJs:true, types:[]}}),
    "esm/core.mjs": "export const value = 1;",
    "common/core.cjs": "exports.value = 2;",
    "wrapper/read.cts": [
      'export const first = () => import((("#entry" as const) satisfies string)!);',
      'export const second = () => import(<string>("#entry"));',
      'export const third = () => import((`#entry`));',
    ].join("\n"),
    "loader/read.mjs": [
      'import {createRequire as factory} from "node:module";',
      'import * as Module from "module";',
      'const load = factory(import.meta.url);',
      'export const one = load(("#entry"));',
      'export const two = Module.createRequire(import.meta.url)("#entry");',
    ].join("\n"),
    "destructured/read.cjs": [
      'const {createRequire: make} = require("node:module");',
      'const load = make(__filename);',
      'exports.three = load("#entry");',
    ].join("\n"),
    "negative/read.mjs": [
      'import {createRequire} from "node:module";',
      'const load = createRequire("file:///different/project/main.js"); load("#entry");',
      'function fake(createRequire) { const local = createRequire(import.meta.url); local("#entry"); }',
      'const unknown = s => import(`#${s}`);',
      'const add = () => import("#" + "entry");',
      'export function arbitrary(load) { return load("#entry"); }',
      'export const prose = \'import(("#entry"))\';',
    ].join("\n"),
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), {recursive:true});
    await writeFile(path.join(root, file), content);
  }
  const graph = await rebuildRelationGraph(root, undefined, await new GitTreeReader(root, root).working(null));
  const uses = graph.edges.flatMap(edge => edge.symbols.filter(symbol => symbol.id.endsWith("/"))
    .flatMap(symbol => symbol.uses.map(use => [use.file, use.line, symbol.definition.file])));
  assert.deepEqual(uses.sort(), [
    ["destructured/read.cjs",3,"common/core.cjs"],
    ["loader/read.mjs",4,"common/core.cjs"], ["loader/read.mjs",5,"common/core.cjs"],
    ["wrapper/read.cts",1,"esm/core.mjs"], ["wrapper/read.cts",2,"esm/core.mjs"], ["wrapper/read.cts",3,"esm/core.mjs"],
  ]);
});

test("links include sources outside tsconfig and an archived partial graph requires rebuilding", async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "archiview-unconfigured-"));
  t.after(() => rm(root, {recursive:true, force:true, maxRetries:4}));
  initTestRepository(root);
  for (const directory of ["app", "scripts", "shared", "nested", "build"]) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, "build/generated.ts"), "export const generated = true;");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {module:"preserve", paths:{"@shared": ["./shared/value.ts"]}}, include:["app", "shared"],
  }));
  await writeFile(path.join(root, "shared/value.ts"), "export const value = true;");
  await writeFile(path.join(root, "nested/tsconfig.json"), JSON.stringify({files:["other.ts"]}));
  await writeFile(path.join(root, "nested/other.ts"), "export const other = true;");
  await writeFile(path.join(root, "app/use.ts"), 'import { value } from "@shared"; export default value;');
  await writeFile(path.join(root, "scripts/use.ts"),
    'import { value } from "@shared"; import { other } from "../nested/other"; export default value && other;');
  const snapshot = await new GitTreeReader(root, root).working(null);
  const graph = await rebuildRelationGraph(root, undefined, snapshot);
  assert.equal(graph.eligible, 4);
  assert.equal(graph.indexed, graph.eligible);
  assert.deepEqual(graph.edges.map(e => [e.from, e.to]).sort(), [["app","shared"],["scripts","nested"],["scripts","shared"]]);
  const saved = path.join(root, ".archiview/snapshots/relations");
  const [filename] = await readdir(saved);
  await writeFile(path.join(saved, filename), JSON.stringify({...graph, indexed: 2}));
  assert.equal(await readRelationGraph(root, undefined, snapshot), null);
});
