import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { registerHarness } from "../web/web-backend/host-bridge/channel.js";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import { createArchiViewSession } from "../web/web-backend/session.js";
import { turnHook } from "../cli/turn-hook.js";
import { createArchiView } from "../web/web-backend/web-service/http.js";
import { digest } from "../framework/serialization/digest.js";
import { captureWorkingTree } from "../analyse/git-changes/capture.js";
import { SnapshotStore } from "../analyse/git-changes/snapshot-store.js";
import { analysisFingerprint } from "../analyse/module-review/analysis-scope.js";
import { observeModules } from "../analyse/module-review/module-observations.js";
import { moduleReportName, ReportStore } from "../analyse/module-review/report-store.js";
import { createReviewInput } from "../analyse/module-review/review-input.js";
import { reviewFreshness } from "../analyse/module-review/model.js";
import type { Fact } from "../framework/snapshots/types.js";
import type { CycleStep, RelationGraph } from "../framework/module-relations/types.js";
import type { ReviewInput } from "../framework/static-report/types.js";
import type { ComparisonView } from "../module-operations/api.js";
import { readDelivery } from "../module-operations/analysis-record.js";
import { commitTestFiles, contractYaml, initTestRepository, writeModuleTree, type ComparisonResponse } from "./support.js";

async function repositoryFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-analysis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "child"));
  initTestRepository(root);
  await writeModuleTree(root, { root: ".", child: "child" });
  for (const [directory, id] of [[".", "root"], ["child", "child"]]) {
    await writeFile(path.join(root, ".archiview/modules", id + ".yaml"), stringify({ schema_version: 1,
      id, title: directory === "." ? "Тестовый проект панели" : "Тестовый модуль", kind: "module",
      purpose: "Возвращать значение.",
      boundaries: { B1: "Не изменять исходники при просмотре." }, invariants: {} }));
  }
  await writeFile(path.join(root, "child/code.js"), "export const value = 1;\n");
  return root;
}

/** Искусственная модель проверяет протокол импорта; она не используется как содержательный анализ кода. */
function completedFixture(input: ReviewInput) {
  const result = structuredClone(input);
  result.report.analysis.model = { provider: "test", id: "protocol-fixture" };
  result.report.analysis.prompt_digest = digest("Protocol fixture, not a real review");
  result.manifest.model = result.report.analysis.model;
  result.manifest.prompt_digest = result.report.analysis.prompt_digest;
  result.report.analysis.input_digest = digest(result.manifest);
  result.report.analysis.coverage = { status: "partial", limitations: ["Protocol fixture; dependencies were not analyzed."] };
  result.report.assessment.current = { verdict: "needs_review", summary: "Protocol fixture only." };
  return result;
}

test("delivery states are literal strings and sent receipts identify the chat", () => {
  const receipt = { harnessId: "local", name: "Local" };
  for (const state of ["pending", "sent", "unknown"]) {
    assert.throws(() => readDelivery({ ...receipt, state: [state], chatId: "chat" }));
    assert.equal(readDelivery({ ...receipt, state, chatId: "chat" }).state, state);
  }
  assert.throws(() => readDelivery({ ...receipt, state: "sent" }));
  assert.throws(() => readDelivery({ ...receipt, state: "sent", chatId: "" }));
});

async function completeCurrentReview(root: string, id: string, finding = false) {
  const folder = path.join(root, ".archiview/snapshots/analysis", id);
  const input: ReviewInput = parse(await readFile(path.join(folder, "input.yaml"), "utf8"));
  assert.equal(input.baseline, null);
  await assert.rejects(stat(path.join(folder, "snapshots.json")), {code:"ENOENT"});
  const result = completedFixture(input);
  result.report.analysis.coverage = {status:"complete", limitations:[]};
  if (input.manifest.analysis_type === "grasp") {
    result.report.extensions = {"archiview.grasp": input.current.modules.filter(module => module.document.contract?.id !== input.module_id)
      .map(module => ({moduleId:module.document.contract!.id, role:"utility", task:"Fixture", assessment:"Fixture", consumers:[input.module_id]}))};
  }
  const evidence = [{snapshot:"current" as const, fact_id:input.current.facts[0].id}];
  for (const clause of result.report.checks) Object.assign(clause, {verdict:"consistent", explanation:"Fixture", evidence});
  if (finding) result.report.findings = [{id:"finding", kind:"contract_conflict", lifecycle:"introduced", certainty:"confirmed",
    severity:"warning", summary:"Review fixture", clauses:[result.report.checks[0].contract], evidence}];
  await writeFile(path.join(folder, "result.yaml"), stringify(result, {aliasDuplicateObjects:false}));
}

test("current reviews select by typed freshness after commits, reparenting and deletion", async t => {
  const root = await repositoryFixture(t);
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "other/index.js"), "export {};");
  await writeFile(path.join(root, ".archiview/modules/other.yaml"), contractYaml("other"));
  const tree = {root:".", other:"other", child:"child"};
  await writeModuleTree(root, tree);
  commitTestFiles(root);
  const app = await createArchiViewSession({root});
  t.after(() => app.close());
  const selected = async () => {
    const {checks} = await app.turns.current();
    assert.ok(checks.every(check => check.status === "pending"));
    return checks.map(check => check.moduleId + "/" + check.type).sort();
  };
  const finishPending = async () => {
    for (const check of (await app.turns.current()).checks) {
      assert.equal(check.status, "pending");
      const request = await app.turns.prepareCurrent(check.moduleId, check.type);
      await completeCurrentReview(root, request.id);
      await app.analysis.complete(request.id);
    }
  };
  assert.equal((await selected()).length, 6, "clean Git tree without reports still needs analysis");
  await finishPending();
  assert.deepEqual(await selected(), []);

  await writeFile(path.join(root,".archiview/modules/child.yaml"),contractYaml("child","Changed contract"));
  commitTestFiles(root);
  assert.deepEqual(await selected(), ["child/grasp", "child/implementation", "root/grasp"]);
  await finishPending();

  await rename(path.join(root,"child"),path.join(root,"other/child"));
  await writeModuleTree(root, {...tree, child:"other/child"});
  assert.deepEqual(await selected(), ["child/grasp", "child/implementation", "other/grasp", "root/grasp"]);
  await finishPending();

  await rm(path.join(root,"other/child"),{recursive:true});
  await rm(path.join(root,".archiview/modules/child.yaml"));
  await writeModuleTree(root, {root:".",other:"other"});
  assert.deepEqual(await selected(), ["other/grasp"]);
});

test("Stop and the CLI share module and relation review work without opening review chats", async t => {
  const root = await repositoryFixture(t);
  const config = path.join(root, ".archiview/agent-review.json");
  const localState = path.join(root, ".archiview/snapshots");
  const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  const execute = (...args: string[]) => promisify(execFile)(process.execPath, [cli,"--root",root,...args], {windowsHide:true});
  const run = async (...args: string[]) => JSON.parse((await execute(...args)).stdout);
  const event = {cwd:path.join(root,"child"), session_id:"author", turn_id:"1"};
  const hook = (hook_event_name: string, overrides = {}) => turnHook("codex", {...event, hook_event_name, ...overrides});
  const code = path.join(root, "child/code.js");
  const cyclicCode = (value: number) =>
    `import { readValue } from "../main.js";\nexport const value = ${value};\nexport const readParent = () => readValue();\n`;
  await writeFile(path.join(root,"package.json"), '{"name":"relation-fixture","type":"module"}');
  await writeFile(path.join(root,"main.js"), 'import { value } from "./child/code.js";\nexport const readValue = () => value;\n');
  await writeFile(code, cyclicCode(1));
  assert.deepEqual(await hook("UserPromptSubmit"), {});
  await writeFile(config, JSON.stringify({enabled:true}));
  const start = await hook("UserPromptSubmit");
  assert.match(start.hookSpecificOutput!.additionalContext, /--review-current/);
  await assert.rejects(stat(path.join(localState,"agent-turns/turns")), {code:"ENOENT"});
  await assert.rejects(stat(path.join(localState,"analysis")), {code:"ENOENT"});
  const list = () => run("--review-current");
  const pending = await list();
  assert.equal(pending.checks.length, 4);
  assert.equal(pending.relations.status, "unindexed");
  const legacy = await run("--review-turn", "a".repeat(64), "--wait", "60");
  assert.deepEqual(legacy.checks, pending.checks);
  assert.deepEqual(legacy.relations, pending.relations);
  assert.equal((await hook("Stop", {session_id:"without-submit"})).decision, "block");
  assert.match((await hook("Stop",{stop_hook_active:true})).systemMessage!, /child\/implementation/);
  await assert.rejects(stat(path.join(localState,"analysis")), {code:"ENOENT"});

  for (const {moduleId,type} of pending.checks) {
    const request = await run("--prepare-current-review",moduleId,"--analysis-type",type);
    assert.match(request.prompt, /--complete-analysis/);
    await completeCurrentReview(root, request.id, moduleId === "child" && type === "implementation");
    await execute("--complete-analysis",request.id);
  }
  const [review] = (await list()).checks;
  assert.equal(review.status, "reviewed");
  assert.equal(review.result.findings[0].id, "finding");
  assert.equal((await hook("Stop")).decision, "block");
  for (const [sessionId,prompt] of [["reviewer","[ArchiView review] 1"],["fixer","[ArchiView fix] 1"]]) {
    assert.deepEqual(await hook("UserPromptSubmit",{session_id:sessionId,prompt}), {});
    assert.deepEqual(await hook("Stop",{session_id:sessionId}), {});
  }

  await writeFile(code, cyclicCode(2));
  const request = await run("--prepare-current-review","child","--analysis-type","implementation");
  await writeFile(code, cyclicCode(3));
  await completeCurrentReview(root, request.id);
  await execute("--complete-analysis",request.id);
  assert.deepEqual((await list()).checks, [{moduleId:"child",type:"implementation",status:"pending"}]);
  const finishImplementation = async () => {
    const fresh = await run("--prepare-current-review","child","--analysis-type","implementation");
    await completeCurrentReview(root, fresh.id);
    await execute("--complete-analysis",fresh.id);
  };
  await finishImplementation();
  assert.deepEqual((await list()).checks, []);
  assert.equal((await hook("Stop")).decision, "block", "an absent graph blocks even with fresh module reports");
  assert.equal((await list()).relations.status, "unindexed", "Stop leaves the work to the same chat");
  const repeated = await hook("Stop",{stop_hook_active:true});
  assert.ok(repeated.systemMessage);
  assert.equal(repeated.decision, undefined);

  await run("--build-relations");
  const graphPending = (await list()).relations;
  assert.equal(graphPending.status, "pending");
  assert.equal((await hook("Stop")).decision, "block", "building the graph does not count as its review");
  const input = await run("--relation-review-input");
  assert.equal(input.graphId, graphPending.graphId);
  assert.ok(path.isAbsolute(input.graphFile));
  assert.equal(input.indexed, 2);
  assert.equal(input.eligible, 2);
  assert.equal(input.edges, 2);
  const graph: RelationGraph = JSON.parse(await readFile(input.graphFile,"utf8"));
  await writeFile(input.graphFile, JSON.stringify({...graph,edges:null}));
  assert.equal((await list()).relations.status, "unindexed");
  await assert.rejects(execute("--relation-review-input"), {code:1});
  await run("--build-relations");
  assert.equal((await run("--relation-review-input")).graphId, input.graphId);
  const cycles: CycleStep[][] = input.cycles;
  assert.deepEqual(cycles.map(chain => chain.map(step => step.from).join("/")).sort(), ["./child", "child/."]);
  for (const {from,to,use} of cycles.flat()) {
    assert.ok(graph.edges.some(edge => edge.from === from && edge.to === to && edge.symbols.some(symbol =>
      symbol.uses.some(site => site.file === use.file && site.line === use.line && site.column === use.column))));
  }
  const {from,to,use} = cycles.flat().find(step => step.from === "child")!;
  const evidence = {from,to,...use};
  const report = {graphId:input.graphId, summary:"Fixture relation assessment", findings:[{
    summary:"The child imports its parent", evidence:[evidence],
  }]};
  const reportFile = path.join(localState,"fixture-relation-result.json");
  const completeRelations = async (value: typeof report) => {
    await writeFile(reportFile, JSON.stringify(value));
    await execute("--complete-relation-review",reportFile);
  };
  await assert.rejects(completeRelations({...report, findings:[{...report.findings[0], evidence:[{...evidence,line:999}]}]}), {code:1});
  assert.equal((await list()).relations.status, "pending");
  await completeRelations(report);
  const {relations:reviewed, checks} = await list();
  assert.equal(reviewed.status, "reviewed");
  assert.deepEqual(reviewed.report.findings, report.findings);
  assert.deepEqual(checks, []);
  assert.equal((await hook("Stop")).decision, "block", "open relation findings also block");
  assert.ok((await hook("Stop",{stop_hook_active:true})).systemMessage);

  await writeFile(code, "export const value = 3;\n");
  await finishImplementation();
  assert.equal((await list()).relations.status, "unindexed");
  await run("--build-relations");
  const fixed = await run("--relation-review-input");
  assert.notEqual(fixed.graphId, input.graphId);
  assert.deepEqual(fixed.cycles, []);
  await assert.rejects(completeRelations(report), {code:1});
  assert.equal((await list()).relations.status, "pending");
  await completeRelations({graphId:fixed.graphId, summary:"The revised graph has no cycle", findings:[]});
  assert.equal((await list()).relations.status, "reviewed");
  assert.deepEqual(await hook("Stop"), {});
});

test("current review skips relation work in repositories without indexed languages", async t => {
  const root = await repositoryFixture(t);
  await rm(path.join(root,"child/code.js"));
  const app = await createArchiViewSession({root});
  t.after(() => app.close());
  assert.equal((await app.turns.current()).relations.status, "unsupported");
});

test("skill instructions supply implementation evidence and invalidate the previous typed analysis after editing", async t => {
  const root = await repositoryFixture(t);
  await rm(path.join(root, "child/code.js"));
  const skill = path.join(root, "child/SKILL.md");
  const instructions = "# Project skill\nFollow the project contract.\n";
  await writeFile(skill, instructions);
  const snapshot = await captureWorkingTree(root);
  const input = createReviewInput(digest(root), null, snapshot, "child", {analysisType:"implementation"});
  assert.equal(input.current.facts.find(f => f.path === "child/SKILL.md")?.text, instructions);
  assert.equal(reviewFreshness(input, null, snapshot).current.status, "fresh");
  await writeFile(skill, instructions + "Read the selected snapshot.\n");
  assert.equal(reviewFreshness(input, null, await captureWorkingTree(root)).current.status, "stale");
});

/** Replay the unversioned writer's leaf-module cursors using its own implementation evidence filter. */
async function observeLegacyChild(reports: ReportStore, includeSkill = false) {
  return reports.withLivePublication(async () => {
    const snapshot = await captureWorkingTree(reports.root);
    const own = snapshot.modules.find(module => module.directory === "child")!;
    const file = path.join(reports.control, "module-observations.json");
    const history = JSON.parse(await readFile(file, "utf8"));
    const prior = history.modules.child;
    const projected = includeSkill ? own : {...own, files:own.files.filter(file => path.posix.basename(file.path) !== "SKILL.md")};
    const fingerprint = digest([own.directory, own.files, own.document]);
    const revision = prior.revision + Number(prior.fingerprint !== fingerprint);
    const typed = (type: "implementation" | "grasp") => {
      const hash = analysisFingerprint(type, [projected]);
      return {hash, revision:prior.types[type].revision + Number(prior.types[type].hash !== hash)};
    };
    const types = {grasp:typed("grasp"), implementation:typed("implementation")};
    history.modules.child = {fingerprint, composition:digest([]), revision, types};
    await writeFile(file, JSON.stringify(history));
    snapshot.observations = {child:{lineage:history.lineage, revision, grasp:types.grasp.revision, implementation:types.implementation.revision}};
    return snapshot;
  });
}

async function observeCurrent(reports: ReportStore) {
  return reports.withLivePublication(async () => {
    const snapshot = await captureWorkingTree(reports.root);
    await observeModules(reports.snapshotStore, snapshot);
    return snapshot;
  });
}

test("observer generations preserve report history and independently track real implementation changes", async t => {
  const root = await repositoryFixture(t);
  const instructions = path.join(root, "child/SKILL.md");
  await writeFile(instructions, "# A\n");
  const store = new SnapshotStore(root);
  const reports = new ReportStore(store);
  const initial = await captureWorkingTree(root);
  const own = initial.modules.find(module => module.directory === "child")!;
  const legacyOwn = {...own, files:own.files.filter(file => file.path !== "child/SKILL.md")};
  const before = {lineage:"fixture-lineage", revision:383, grasp:1, implementation:12};
  initial.observations = {child:before};
  const legacyRecord = {
    fingerprint:digest([own.directory, own.files, own.document]), composition:digest([]), revision:before.revision,
    types:{
      grasp:{hash:analysisFingerprint("grasp", [own]), revision:before.grasp},
      implementation:{hash:analysisFingerprint("implementation", [legacyOwn]), revision:before.implementation},
    },
  };
  assert.notEqual(legacyRecord.types.implementation.hash, analysisFingerprint("implementation", [own]));
  const legacyFile = path.join(reports.control, "module-observations.json");
  const writeLegacy = () => reports.withLivePublication(() =>
    writeFile(legacyFile, JSON.stringify({lineage:before.lineage, modules:{child:legacyRecord}})));
  await writeLegacy();
  // Both projections were used before observers acquired separate cursor files.
  const legacySnapshot = {...initial, modules:initial.modules.map(module => module === own ? legacyOwn : module)};
  for (const snapshot of [legacySnapshot, initial]) {
    const result = completedFixture(createReviewInput(digest(root), null, snapshot, "child", {analysisType:"implementation"}));
    result.report.analysis.coverage = {status:"complete", limitations:[]};
    for (const check of result.report.checks) Object.assign(check, {verdict:"consistent", explanation:"Fixture",
      evidence:[{snapshot:"current", fact_id:result.current.facts[0].id}]});
    await reports.saveReview(result);
  }
  const historyFile = path.join(reports.work, moduleReportName("child") + ".review.yaml");
  const originalBytes = await readFile(historyFile);
  const entries = await reports.readModuleReviews("child");
  const full = entries.find(entry => entry.current.facts.some(fact => fact.path === "child/SKILL.md"))!;
  const incomplete = entries.find(entry => entry.review_id !== full.review_id)!;
  const observe = () => observeCurrent(reports);
  const migrated = await observe();
  assert.deepEqual(migrated.observations!.child, {...before, skillHistory:{since:383}});
  assert.equal(reviewFreshness(full, null, migrated).current.status, "fresh");
  assert.equal(reviewFreshness(incomplete, null, migrated).current.status, "stale");

  const currentReport = createReviewInput(digest(root), null, migrated, "child", {analysisType:"implementation"});
  const legacyTarget = await observeLegacyChild(reports, true);
  assert.equal(reviewFreshness(currentReport, null, legacyTarget).current.status, "fresh");
  await observeLegacyChild(reports);
  const toggled = await observe();
  assert.deepEqual(toggled.observations!.child, migrated.observations!.child);
  assert.equal(reviewFreshness(full, null, toggled).current.status, "fresh");
  await writeFile(instructions, "# B\n");
  const changed = await observe();
  assert.deepEqual(changed.observations!.child, {...before, revision:384, implementation:13, skillHistory:{since:383, changedAt:384}});
  await writeFile(instructions, "# A\n");
  await observeLegacyChild(reports);
  const reverted = await observe();
  assert.deepEqual(reverted.observations!.child, {...before, revision:385, implementation:14, skillHistory:{since:383, changedAt:385}});
  assert.equal(reviewFreshness(full, null, reverted).current.status, "stale");
  const confirmed = createReviewInput(digest(root), null, reverted, "child", {analysisType:"implementation"});
  await writeFile(instructions, "# C\n");
  await observeLegacyChild(reports);
  await writeFile(instructions, "# A\n");
  const lateLegacy = await observeLegacyChild(reports, true);
  const lateReview = createReviewInput(digest(root), null, lateLegacy, "child", {analysisType:"implementation"});
  const afterGap = await observe();
  assert.equal(reviewFreshness(confirmed, null, afterGap).current.status, "unknown");
  assert.equal(reviewFreshness(lateReview, null, afterGap).current.status, "fresh");
  assert.deepEqual(await reports.readModuleReviews("child"), entries);
  assert.deepEqual(await readFile(historyFile), originalBytes);
});

test("a skill review made at the last shared observation survives later documentation changes", async t => {
  const root = await repositoryFixture(t);
  const reports = new ReportStore(new SnapshotStore(root));
  await writeFile(path.join(root, "child/SKILL.md"), "# Rules\n");
  const code = path.join(root, "child/code.js"), original = await readFile(code, "utf8");
  const readme = path.join(root, "child/README.md");
  const current = () => observeCurrent(reports);
  const review = (snapshot: Awaited<ReturnType<typeof current>>) =>
    createReviewInput(digest(root), null, snapshot, "child", {analysisType:"implementation"});
  const state = (entry: ReviewInput, target: Awaited<ReturnType<typeof current>>) => reviewFreshness(entry, null, target).current.status;
  const first = review(await current());
  await writeFile(code, "export const value = 2;\n");
  await observeLegacyChild(reports, true);
  await writeFile(code, original);
  const last = await observeLegacyChild(reports, true);
  const late = completedFixture(review(last));
  late.report.analysis.coverage = {status:"complete", limitations:[]};
  for (const check of late.report.checks) Object.assign(check, {verdict:"consistent", explanation:"Fixture",
    evidence:[{snapshot:"current", fact_id:late.current.facts[0].id}]});
  await reports.saveReview(late);
  const hash = (snapshot: typeof last) =>
    analysisFingerprint("implementation", [snapshot.modules.find(module => module.directory === "child")!]);
  for (const text of ["First note", "Second note"]) {
    await writeFile(readme, text);
    const target = await current();
    assert.equal(hash(target), hash(last));
    assert.ok(target.observations!.child.revision > last.observations!.child.revision);
    assert.equal(target.observations!.child.skillHistory!.uncertainAt, last.observations!.child.revision);
    assert.equal(state(first, target), "unknown");
    assert.equal(state(late, target), "fresh");
  }
  const app = await createWorkspaceSession({root});
  try {
    const view = await app.getComparison();
    const detail = await app.getModule({view:view.id, path:"child", currentOnly:true});
    const tree = await app.getReviewStatuses({view:view.id});
    assert.equal(detail.analyses?.implementation?.id, late.review_id);
    assert.equal(tree.modules.find(module => module.key === "child")?.analyses?.implementation?.id, late.review_id);
  } finally { await app.close(); }

  for (const fullProjection of [true, false]) {
    const before = review(await current());
    await writeFile(readme, "Shared capture " + fullProjection);
    const shared = review(await observeLegacyChild(reports, fullProjection));
    await writeFile(readme, "Current capture " + fullProjection);
    const docs = await current();
    assert.equal(state(before, docs), fullProjection ? "fresh" : "unknown");
    assert.equal(state(shared, docs), "fresh");
    const baseline = review(docs);
    await writeFile(code, "export const value = 3;\n");
    await observeLegacyChild(reports, fullProjection);
    await writeFile(code, original);
    const restored = await current();
    assert.equal(hash(restored), hash(docs));
    assert.equal(state(baseline, restored), "stale");
    assert.equal(state(late, restored), "stale");
  }
});

test("compatible observers share implementation and GRASP cursors across reverts in either direction", async t => {
  const root = await repositoryFixture(t);
  const reports = new ReportStore(new SnapshotStore(root));
  const source = path.join(root, "child/code.js");
  const contract = path.join(root, ".archiview/modules/child.yaml");
  const originalSource = await readFile(source, "utf8"), originalContract = await readFile(contract, "utf8");
  const modern = () => observeCurrent(reports), legacy = () => observeLegacyChild(reports);
  await modern();
  for (const [writer, reader] of [[legacy, modern], [modern, legacy]]) {
    const before = await reader();
    await writeFile(source, "export const value = 2;\n");
    await writeFile(contract, originalContract.replace("Возвращать значение.", "Возвращать два."));
    await writer();
    await writeFile(source, originalSource);
    await writeFile(contract, originalContract);
    const after = await writer(), target = await reader();
    assert.deepEqual(target.observations!.child, after.observations!.child);
    for (const analysisType of ["implementation", "grasp"] as const) {
      const makeReview = (snapshot: typeof before) => createReviewInput(digest(root), null, snapshot, "child", {analysisType});
      assert.equal(after.observations!.child[analysisType], before.observations!.child[analysisType]! + 2);
      assert.equal(reviewFreshness(makeReview(before), null, target).current.status, "stale");
      assert.equal(reviewFreshness(makeReview(after), null, target).current.status, "fresh");
    }
  }
});

test("removing the last skill rejoins the common implementation cursor without reviving a previous review", async t => {
  const root = await repositoryFixture(t);
  const reports = new ReportStore(new SnapshotStore(root));
  const current = () => observeCurrent(reports);
  const review = (snapshot: Awaited<ReturnType<typeof current>>) =>
    createReviewInput(digest(root), null, snapshot, "child", {analysisType:"implementation"});
  const first = review(await current());
  const skill = path.join(root, "child/SKILL.md");
  await writeFile(skill, "# Skill\n");
  await current();
  await rm(skill);
  const plain = await current();
  assert.equal(reviewFreshness(first, null, plain).current.status, "stale");
  const baseline = review(plain);
  const code = path.join(root, "child/code.js"), original = await readFile(code, "utf8");
  await writeFile(code, "export const value = 3;\n");
  await observeLegacyChild(reports);
  await writeFile(code, original);
  const legacy = review(await observeLegacyChild(reports));
  const restored = await current();
  assert.equal(reviewFreshness(baseline, null, restored).current.status, "stale");
  assert.equal(reviewFreshness(legacy, null, restored).current.status, "fresh");
});
test("typed analyses track only their own inputs and keep decisions outside the immutable report", async t => {
  const root = await repositoryFixture(t);
  await mkdir(path.join(root, "child/grand"));
  await writeFile(path.join(root, "child/grand/index.js"), "export const grand = true;\n");
  await writeModuleTree(root, {root:".", child:"child", grand:"child/grand"});
  const childContract = path.join(root, ".archiview/modules/child.yaml");
  const child = parse(await readFile(childContract, "utf8"));
  const grandContract = path.join(root, ".archiview/modules/grand.yaml");
  await writeFile(grandContract, stringify({...child, id:"grand"}));
  commitTestFiles(root);
  const app = await serve(t, root);
  const initial = await app.getComparison();
  const entries = new Map<string, ReviewInput>();
  for (const [directory, type] of [[".", "grasp"], ["child", "grasp"], ["child", "implementation"]] as const) {
    const request = await app.prepareAnalysis({view:initial.id, path:directory, analysisType:type});
    const folder = path.join(root, ".archiview/snapshots/analysis", request.id);
    const input: ReviewInput = parse(await readFile(path.join(folder, "input.yaml"), "utf8"));
    assert.equal(input.baseline, null);
    assert.equal(input.manifest.analysis_type, type);
    assert.equal(input.manifest.source_snapshot?.id, initial.after.id);
    assert.equal(input.manifest.source_snapshot.digest, initial.after.digest);
    assert.deepEqual(input.current.modules.map(m => m.directory).sort(),
      type === "implementation" ? ["child"] : directory === "." ? [".", "child"] : ["child", "child/grand"]);
    const code = input.current.facts.filter(f => f.path.endsWith(".js"));
    assert.equal(code.length, Number(type === "implementation"));
    const result = completedFixture(input);
    const save = () => writeFile(path.join(folder, "result.yaml"), stringify(result, {aliasDuplicateObjects:false}));
    await save();
    await assert.rejects(app.analysis.complete(request.id));
    result.report.analysis.coverage = {status:"complete", limitations:[]};
    if (type === "grasp") result.report.extensions = {"archiview.grasp": input.current.modules.filter(m => m.directory !== directory)
      .map(m => ({moduleId:m.document.contract!.id, role:"utility", task:"Fixture", assessment:"Fixture", consumers:[input.module_id]}))};
    const evidence = [{snapshot:"current" as const, fact_id:(code[0] ?? input.current.facts[0]).id}];
    for (const check of result.report.checks) Object.assign(check, {verdict:"consistent", explanation:"Fixture", evidence});
    result.report.findings = [{id:"finding", summary:"Исходный заголовок", severity:"warning", certainty:"confirmed",
      kind:"contract_conflict", lifecycle:"unknown", clauses:[result.report.checks[0].contract], evidence}];
    // Direct imports verify the stored evidence against the typed file inventory too.
    const outside = structuredClone(result);
    const content = { kind: "file", path: type === "grasp" ? "child/code.js" : "child/extra.js", text: "Fixture" };
    const fact = { ...content, id: digest(content) };
    outside.current.facts.push(fact);
    outside.report.checks[0].evidence = [{ snapshot: "current", fact_id: fact.id }];
    delete outside.current.scope_digest;
    outside.current.scope_digest = digest(outside.current);
    await assert.rejects(app.reports.saveReview(outside), /outside analysis scope/);
    await save();
    await app.analysis.complete(request.id);
    entries.set(directory + type, result);
    result.report.findings[0].summary += " изменён";
    await save();
    await assert.rejects(app.analysis.complete(request.id), /collision/i);
  }

  const args = {view:(await app.getComparison()).id, path:"child", currentOnly:true};
  const detail = await app.getModule(args);
  const reviewId = entries.get("childimplementation")!.review_id;
  assert.equal(detail.analyses?.implementation?.id, reviewId);
  assert.equal(detail.reviews.length, 2);
  const head = initial.timeline.find(item => item.kind === "git")!;
  const past = await app.getComparison({target:head.id});
  assert.deepEqual((await app.getModule({view:past.id, path:"child", currentOnly:true})).reviews, []);
  const sealed = digest(detail.reviews.find(review => review.report.id === reviewId)!.report);
  const post = (body: object) => fetch(app.url + "/api/findings/decision", {method:"POST",
    headers:{"content-type":"application/json"}, body:JSON.stringify(body)});
  const payload = {view:args.view, path:"child", reviewId, findingId:"finding", expected:{status:"open",decision:""},
    status:"resolved", decision:"Исправлено."};
  for (const field of ["summary", "title", "tags", "severity", "evidence"]) assert.equal((await post({...payload,[field]:"edit"})).status, 400);
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post(payload)).status, 200);
  assert.equal((await post({...payload, decision:"Перезапись из старой вкладки"})).status, 409);
  const after = await app.getModule(args);
  assert.equal(after.analyses?.implementation?.openFindings, 0);
  const updated = after.reviews.find(review => review.report.id === reviewId)!;
  assert.equal(digest(updated.report), sealed);
  assert.deepEqual(updated.dispositions?.finding, {status:"resolved", decision:"Исправлено."});
  const statuses = async () => {
    const view = await app.getComparison();
    return Object.fromEntries((await app.getReviewStatuses({view:view.id})).modules.map(m => [m.key, Object.keys(m.analyses ?? {}).sort()]));
  };
  assert.deepEqual(await statuses(), {".":["grasp"], child:["grasp","implementation"], "child/grand":[]});
  await writeFile(path.join(root, "unrelated.txt"), "Later commit");
  commitTestFiles(root);
  async function headResults() {
    const id = (await app.getComparison()).timeline.filter(item => item.kind === "git").at(-1)!.id;
    const historical = await app.getComparison({target:id});
    return (await app.getModule({view:historical.id, path:"child", currentOnly:true})).analyses;
  }
  assert.equal((await headResults())?.implementation?.id, reviewId, "matching inputs carry forward into a later commit");
  const file = path.join(root, "child/code.js");
  const original = await readFile(file);
  await writeFile(file, "export const changed = true;");
  assert.deepEqual(await statuses(), {".":["grasp"], child:["grasp"], "child/grand":[]});
  commitTestFiles(root);
  await writeFile(file, original);
  commitTestFiles(root);
  assert.equal((await headResults())?.implementation, undefined, "an intermediate Git change invalidates the earlier review after a revert");
  assert.deepEqual((await statuses()).child, ["grasp"], "a reverted implementation requires a new analysis");
  await writeFile(grandContract, stringify({...child, id:"grand", purpose:"Новое назначение"}));
  assert.deepEqual(await statuses(), {".":["grasp"], child:[], "child/grand":[]});
  await writeFile(childContract, stringify({...child, purpose:"Новое назначение ребёнка"}));
  assert.deepEqual((await statuses())["."], []);
});

test("Git tree and separate reviews preserve module order across a revert, a late import, a restart and a commit", async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(path.join(root, ".gitignore"), "*.tmp\n");
  commitTestFiles(root);
  let workspace = await createWorkspaceSession({ root });
  async function tree() { return workspace.getComparison(); }
  async function statuses(view: ComparisonView) {
    const result = await workspace.getReviewStatuses({ view: view.id });
    return Object.fromEntries(result.modules.map(m => [m.key, m.reviewStatus?.self.current.status]));
  }
  const first = await tree();
  assert.equal(first.separateAnalysis, true);
  assert.ok(first.modules.every(m => !m.reviewStatus));
  async function review(view: ComparisonView, key: string) {
    const request = await workspace.prepareAnalysis({ view: view.id, path: key });
    const folder = path.join(root, ".archiview/snapshots/analysis", request.id);
    const input: ReviewInput = parse(await readFile(path.join(folder, "input.yaml"), "utf8"));
    await writeFile(path.join(folder, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
    return () => workspace.session().then(session => session.analysis.complete(request.id));
  }
  const parent = await review(first, ".");
  const child = await review(first, "child");
  await parent();
  const filename = "child/новый файл.js";
  await writeFile(path.join(root, filename), "new\n");
  await writeFile(path.join(root, "ignored.tmp"), "ignore");
  const changed = await tree();
  assert.deepEqual((await workspace.getModule({ view: changed.id, path: "child", analysis: false })).files,
    [{ path: filename, status: "new" }]);
  assert.equal(changed.modules.find(m => m.key === ".")!.status, "unchanged");
  await rm(path.join(root, filename));
  await child();
  workspace = await createWorkspaceSession({ root });
  const reverted = await tree();
  assert.equal(reverted.counts.changed, 0);
  assert.deepEqual(await statuses(reverted), { ".": "fresh", child: "stale" });
  await writeFile(path.join(root, "child/code.js"), "updated\n");
  const next = await tree();
  await (await review(next, "child"))();
  assert.deepEqual(await statuses(await tree()), { ".": "fresh", child: "fresh" });
  commitTestFiles(root);
  const committed = await tree();
  assert.equal(committed.counts.changed, 0);
  assert.deepEqual(await statuses(committed), { ".": "fresh", child: "fresh" });
  const contractPath = path.join(root, ".archiview/modules/child.yaml");
  const original = await readFile(contractPath, "utf8");
  const declaration = parse(original);
  declaration.purpose += " Изменённое обещание.";
  await writeFile(contractPath, stringify(declaration));
  assert.deepEqual(await statuses(await tree()), { ".": "stale", child: "stale" });
  await writeFile(contractPath, original);
  workspace = await createWorkspaceSession({ root });
  assert.deepEqual(await statuses(await tree()), { ".": "stale", child: "stale" });

});

/** Открывает временный backend и закрывает ровно принадлежащие тесту соединения. */
async function serve(t: TestContext, root: string) {
  const app = await createArchiView({ root });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>((resolve) => app.server.close(() => resolve())); });
  return { ...app, url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port };
}

/** Создаёт запрос кнопки в реальном API, а не напрямую в модели хранения. */
async function prepare(app: { url: string }, view: { id: string }, module = "child") {
  return fetch(app.url + "/api/analysis", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id, path: module }) });
}

test("only live harness registrations can receive a request, and concurrent delivery creates one chat", async t => {
  const root = await repositoryFixture(t);
  const folder = await mkdtemp(path.join(os.tmpdir(), "archiview-registrations-"));
  const previous = process.env.ARCHIVIEW_BRIDGE_DIR;
  process.env.ARCHIVIEW_BRIDGE_DIR = folder;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARCHIVIEW_BRIDGE_DIR;
    else process.env.ARCHIVIEW_BRIDGE_DIR = previous;
    await rm(folder, { recursive: true, force: true });
  });
  let calls = 0;
  let acknowledge!: () => void;
  const ack = new Promise<void>(resolve => { acknowledge = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const close = await registerHarness({ kind: "dsh", instance: "test-dsh", async available() {},
    async start(job) {
      calls++;
      assert.equal(job.repositoryRoot, root);
      assert.equal(job.moduleId, "child");
      assert.ok(job.prompt.includes(job.requestId));
      entered();
      await ack;
      return "test-chat";
    } });
  try {
    const app = await serve(t, root);
    const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
    const request = await (await prepare(app, view)).json();
    const list = async () => (await (await fetch(app.url + "/api/harnesses")).json()).harnesses;
    const [host] = await list();
    const post = () => fetch(app.url + "/api/analysis/deliver", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: request.id, harnessId: host.id }) });
    const send = post();
    await started;
    assert.equal((await (await post()).json()).state, "pending");
    acknowledge();
    const receipt = await (await send).json();
    assert.equal(receipt.state, "sent");
    assert.equal(receipt.chatId, "test-chat");
    assert.deepEqual(await (await post()).json(), receipt);
    assert.equal(calls, 1);
    const status = await (await fetch(app.url + "/api/analysis/" + request.id)).json();
    assert.equal(status.status, "prepared");
    assert.deepEqual(status.delivery, receipt);
    await close();
    assert.deepEqual(await list(), []);
    const next = await (await prepare(app, view)).json();
    const offline = await fetch(app.url + "/api/analysis/deliver", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: next.id, harnessId: host.id }) });
    assert.equal(offline.status, 409);

    let uncertainCalls = 0;
    const stop = await registerHarness({ kind: "codex", instance: "lost-ack", async available() {}, async start() {
      uncertainCalls++;
      throw new Error("Хост закрыл соединение после запроса");
    } });
    try {
      const [codex] = await list();
      const deliver = () => app.deliverAnalysis({id: next.id, harnessId: codex.id});
      assert.equal((await deliver()).state, "unknown");
      const reopened = await createWorkspaceSession({root});
      try {
        assert.equal((await reopened.getAnalysis({id: next.id})).delivery?.state, "unknown");
        assert.equal((await reopened.deliverAnalysis({id: next.id, harnessId: codex.id})).state, "unknown");
      } finally { await reopened.close(); }
      assert.equal(uncertainCalls, 1);
    } finally { await stop(); }
  } finally { acknowledge(); await close(); }
});

test("a delivery survives its sender exiting before the harness acknowledges the chat", {timeout: 30_000}, async t => {
  const root = await repositoryFixture(t);
  const previous = process.env.ARCHIVIEW_BRIDGE_DIR;
  process.env.ARCHIVIEW_BRIDGE_DIR = await mkdtemp(path.join(os.tmpdir(), "archiview-sender-"));
  const folder = process.env.ARCHIVIEW_BRIDGE_DIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARCHIVIEW_BRIDGE_DIR;
    else process.env.ARCHIVIEW_BRIDGE_DIR = previous;
    await rm(folder, {recursive: true, force: true});
  });
  let calls = 0;
  let acknowledge!: () => void;
  const ack = new Promise<void>(resolve => { acknowledge = resolve; });
  let entered!: () => void;
  const enteredStart = new Promise<void>(resolve => { entered = resolve; });
  const stop = await registerHarness({kind:"dsh",instance:"recovery-fixture", async available() {},
    async start() { ++calls; entered(); await ack; return "chat"; }
  });
  const app = await createWorkspaceSession({root});
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const view = await app.getComparison();
    const request = await app.prepareAnalysis({view:view.id, path:"child"});
    const [host] = (await app.listHarnesses({})).harnesses;
    const args = {id:request.id, harnessId:host.id};
    child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval",
      'import {createWorkspaceSession} from "./web/web-backend/workspace-session.ts"; const session = await createWorkspaceSession({root:process.argv[1]}); await session.deliverAnalysis({id:process.argv[2],harnessId:process.argv[3]});',
      root, request.id, host.id], {cwd:fileURLToPath(new URL("../", import.meta.url)),stdio:"ignore",windowsHide:true});
    const exit = once(child, "exit");
    await Promise.race([enteredStart, exit.then(() => { throw new Error("Sender exited before calling the harness"); })]);
    assert.equal((await app.getAnalysis({id:request.id})).delivery?.state, "pending");
    child.kill();
    await exit;
    const [status, retry] = await Promise.all([app.getAnalysis({id:request.id}), app.deliverAnalysis(args)]);
    assert.equal(status.delivery?.state, "unknown");
    assert.equal(retry.state, "unknown");
    assert.equal((await (await createWorkspaceSession({root})).deliverAnalysis(args)).state, "unknown");
    assert.equal(calls, 1);

    const legacy = await app.prepareAnalysis({view:view.id, path:"child"});
    const file = path.join(root, ".archiview/snapshots/analysis", legacy.id, "delivery.json");
    const pending = {harnessId:host.id, name:host.name, state:"pending"};
    await writeFile(file, JSON.stringify(pending));
    assert.equal((await app.getAnalysis({id:legacy.id})).delivery?.state, "pending");
    const old = new Date(Date.now() - 120_000);
    await utimes(file, old, old);
    assert.equal((await app.deliverAnalysis({id:legacy.id, harnessId:host.id})).state, "unknown");
    await writeFile(file, JSON.stringify({...pending, state:"sent", chatId:"late-ack"}));
    assert.equal((await app.getAnalysis({id:legacy.id})).delivery?.chatId, "late-ack");
    assert.equal(calls, 1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    acknowledge();
    await stop();
    await app.close();
  }
});

test("concurrent standalone checkouts with one external state root isolate requests and complete through the exact CLI path", async t => {
  const a = await repositoryFixture(t);
  await writeFile(path.join(a, ".archiview/project.json"), JSON.stringify({schema_version:1,snapshot_root:a}));
  commitTestFiles(a);
  const temp = await mkdtemp(path.join(os.tmpdir(), "archiview-external-"));
  t.after(() => rm(temp, {recursive:true,force:true}));
  const b = path.join(temp, "clone"), stateDirectory = path.join(temp,"state");
  const run = promisify(execFile);
  await run("git", ["clone","-q",a,b]);
  const sessions = await Promise.all([a,b].map(async root => {
    const workspace = await createWorkspaceSession({root,stateDirectory});
    t.after(() => workspace.close());
    const session = await workspace.session();
    const view = await session.getComparison();
    return {session, request:await session.prepareAnalysis({view:view.id,path:"child"})};
  }));
  const [left,right] = sessions;
  assert.notEqual(left.session.store.directory, right.session.store.directory);
  assert.ok(sessions.some(({session}) => session.store.directory === stateDirectory));
  await assert.rejects(left.session.getAnalysis({id:right.request.id}), {code:"ENOENT"});
  await assert.rejects(right.session.getAnalysis({id:left.request.id}), {code:"ENOENT"});
  const {session,request} = sessions.find(item => item.session.store.directory !== stateDirectory)!;
  const directory = path.join(session.store.directory, "snapshots", "analysis", request.id);
  const input = parse(await readFile(path.join(directory,"input.yaml"),"utf8"));
  await writeFile(path.join(directory,"result.yaml"),stringify(completedFixture(input),{aliasDuplicateObjects:false}));
  const cli = ["--import",import.meta.resolve("tsx"),fileURLToPath(new URL("../cli/cli.ts",import.meta.url))];
  await run(process.execPath,[...cli,"--root",session.root,"--state-dir",session.store.directory,"--complete-analysis",request.id]);
  assert.equal((await session.getAnalysis({id:request.id})).status,"completed");

  // A legacy request-only store has the owner's native project_id but no project.json yet.
  const flat = sessions.find(item => item.session.store.directory === stateDirectory)!;
  await rm(path.join(stateDirectory,"project.json"));
  for (const previous of [session,flat.session]) {
    const reopened = await createWorkspaceSession({root:previous.root,stateDirectory});
    try { assert.equal((await reopened.session()).store.directory, previous.store.directory); }
    finally { await reopened.close(); }
  }
});

test("analysis exports exactly the selected view, imports through CLI once, and becomes stale against changed code", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const response = await prepare(app, view);
  assert.equal(response.status, 201);
  const request = await response.json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const input = parse(await readFile(path.join(directory, "input.yaml"), "utf8"));
  assert.equal(input.module_id, "child");
  assert.ok(input.current.facts.some((fact: Fact) => fact.text === "export const value = 1;\n"));
  assert.ok(!input.current.facts.some((fact: Fact) => fact.text === "export const value = 2;\n"));
  assert.equal((await app.analysis.status(request.id)).status, "prepared");
  assert.equal((await app.reports.list()).entries.length, 0);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  const args = ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../cli/cli.ts", import.meta.url)), "--root", root, "--complete-analysis", request.id];
  await promisify(execFile)(process.execPath, args);
  await promisify(execFile)(process.execPath, args);
  const entries = (await app.reports.list()).entries;
  assert.equal(entries.length, 1);
  assert.equal((await (await fetch(app.url + "/api/analysis/" + request.id)).json()).status, "completed");
  const live = await app.getComparison();
  const statuses = await app.getReviewStatuses({ view: live.id });
  assert.equal(statuses.modules.find(m => m.key === "child")!.reviewStatus!.self.current.status, "stale");
  const child = (await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>)).modules.find((module) => module.moduleId === "child");
  assert.equal(child!.reviewStatus!.self.current.status, "stale");
});

test("analysis rejects unknown view/module, missing contracts, changed inputs and redirected result files", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  assert.equal((await prepare(app, { id: "expired" })).status, 409);
  assert.equal((await prepare(app, view, "../outside")).status, 404);
  const request = await (await prepare(app, view)).json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const input = parse(await readFile(path.join(directory, "input.yaml"), "utf8"));
  const result = completedFixture(input);
  result.inputs.current.dependency_coverage = { status: "complete", potential_influence: [] };
  await writeFile(path.join(directory, "result.yaml"), stringify(result, { aliasDuplicateObjects: false }));
  await assert.rejects(app.analysis.complete(request.id), /Изменены входы анализа/);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  const outside = path.join(root, "redirected-analysis");
  await rename(directory, outside);
  await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(app.analysis.complete(request.id), /ссыл|storage|Недопустимый/i);
  assert.equal((await app.reports.list()).entries.length, 0);
  await writeModuleTree(root, { root: "." });
  await rm(path.join(root, ".archiview/modules/child.yaml"));
  const missing = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  assert.equal((await prepare(app, missing)).status, 422);
});

test("CLI rejects dependency collection flags before reading a selector file or creating an export", async (t) => {
  const root = await repositoryFixture(t);
  const output = path.join(root, "disabled-export.yaml");
  const cli = fileURLToPath(new URL("../cli/cli.ts", import.meta.url));
  for (const flags of [["--dependencies", path.join(root, "missing-selectors.yaml")], ["--dependencies-complete"]]) {
    await assert.rejects(promisify(execFile)(process.execPath,
      ["--import", "tsx", cli, "--root", root, "--export-review-input", "child", "--output", output, ...flags], { windowsHide: true }),
      (error: Error & { stderr?: string }) => /Сбор зависимостей через LLM отключён/.test(error.stderr ?? ""));
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
});

test("analysis rejects LLM dependency collection and re-exports original own inputs without changing proof", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const request = await (await prepare(app, view)).json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const original = await readFile(path.join(directory, "input.yaml"), "utf8");
  await writeFile(path.join(root, "child/code.js"), "export const value = 99;\n");
  await assert.rejects(app.analysis.prepare(request.id, [{ kind: "file", path: "child/code.js" }]), /LLM отключён/);
  await assert.rejects(app.analysis.prepare(request.id, [], true), /LLM отключён/);
  const exported = await app.analysis.prepare(request.id, []);
  const input = parse(await readFile(exported, "utf8"));
  assert.deepEqual(input.inputs.current.dependencies, []);
  assert.equal(input.inputs.current.dependency_coverage.status, "unknown");
  assert.ok(input.current.facts.some((fact: Fact) => fact.text === "export const value = 1;\n"));
  assert.equal(await readFile(path.join(directory, "input.yaml"), "utf8"), original);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  assert.equal((await app.analysis.complete(request.id)).status, "completed");
});

test("a prepared review accepts a result above 32 MiB within its input-relative byte budget", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await app.getComparison({ baseline: "initial" });
  const request = await app.prepareAnalysis({ view: view.id, path: "child" });
  const exported = await app.analysis.prepare(request.id, []);
  const input = parse(await readFile(exported, "utf8"));
  const result = path.join(path.dirname(exported), "result.yaml");
  const inputBytes = (await stat(exported)).size;
  const allowance = 32 * 1024 * 1024;
  await writeFile(result, "");
  await truncate(result, inputBytes + allowance + 1);
  await assert.rejects(app.analysis.complete(request.id), /Недопустимый файл анализа/);
  assert.equal((await app.analysis.status(request.id)).status, "prepared");

  // YAML comments affect the transport size without creating a huge persisted review.
  const yaml = stringify(completedFixture(input), { aliasDuplicateObjects: false });
  await writeFile(result, yaml + "#" + "a".repeat(inputBytes + allowance - Buffer.byteLength(yaml) - 1));
  assert.equal((await stat(result)).size, inputBytes + allowance);
  assert.equal((await app.analysis.complete(request.id)).status, "completed");
});

test("request metadata keeps its own size limit while saved snapshots have a larger limit", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await app.getComparison({ baseline: "initial" });
  const request = await app.prepareAnalysis({ view: view.id, path: "child" });
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const requestFile = path.join(directory, "request.json");
  const metadata = await readFile(requestFile);
  await truncate(requestFile, 32 * 1024 * 1024 + 1);
  await assert.rejects(app.analysis.status(request.id), /Недопустимый файл анализа/);
  await writeFile(requestFile, metadata);
  await truncate(path.join(directory, "scope.json"), 32 * 1024 * 1024 + 1);
  await assert.rejects(app.analysis.complete(request.id), /Недопустимый файл анализа/);
  await truncate(path.join(directory, "snapshots.json"), 256 * 1024 * 1024 + 1);
  await assert.rejects(app.analysis.prepare(request.id, []), /Недопустимый файл анализа/);
});
