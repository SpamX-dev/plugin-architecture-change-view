import type { ReviewHistory, ReviewInput } from "../src/reports/types.js";
import type { TestContext } from "node:test";
/** Проверка реального staged-набора, CLI и переносимости без локального накопления. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stringify } from "yaml";
import { createArchiView } from "../src/archiview/http.js";
import { checkPreparedIndex } from "../src/storage/report-index.js";
import { entryContentDigest } from "../src/reports/review-identity.js";
import { moduleReportName } from "../src/storage/report-store.js";
import { digest } from "../src/serialization/digest.js";
import { parseYaml } from "../src/serialization/yaml.js";
const cli = fileURLToPath(new URL("../src/archiview/cli.ts", import.meta.url));
const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
const run = (root: string, args: string[]) => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "--root", root, ...args], { windowsHide: true, encoding: "utf8" });
const contract = (id: string) => ({ schema_version: 1, id, title: id, kind: "module", purpose: "Предоставлять значение.",
  responsibilities: { R1: "Читать значение." }, boundaries: {}, invariants: {} });

/** Каждый сценарий владеет своей Git identity, временной папкой и файлами. */
async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-prepared-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await mkdir(root);
  await writeFile(path.join(root, "arch.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, "code.js"), "export const value = 1;\n");
  git(root, ["init", "-q"]); git(root, ["config", "user.name", "Report Test"]);
  git(root, ["config", "user.email", "reports@example.invalid"]); git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["add", "."]); git(root, ["commit", "-qm", "Source"]);
  return { root, temporary };
}

test("prepared-index validation uses staged code and current reports, never working files or baseline", async (t) => {
  const { root } = await fixture(t);
  run(root, ["--build-report"]);
  git(root, ["add", ".archiview"]);
  assert.equal((await checkPreparedIndex(root)).modules, 1);
  // Незастейдженная правка не должна менять результат проверки подготовленного коммита.
  await writeFile(path.join(root, "code.js"), "export const value = 2;\n");
  assert.equal((await checkPreparedIndex(root)).modules, 1);
  git(root, ["add", "code.js"]);
  await assert.rejects(checkPreparedIndex(root), /different states/);
  run(root, ["--build-report"]);
  git(root, ["add", ".archiview"]);
  assert.equal((await checkPreparedIndex(root)).modules, 1);
  // Откат staged-кода к базе не должен пройти по совпадению с publication.baseline.
  git(root, ["restore", "--staged", "code.js"]);
  await assert.rejects(checkPreparedIndex(root), /different states/);
  git(root, ["rm", "--cached", ".archiview/project.json"]);
  await assert.rejects(checkPreparedIndex(root), /requires project.json/);
});

test("CLI exports scoped YAML, imports a real attempt idempotently, and clone retains history without snapshots", async (t) => {
  const { root, temporary } = await fixture(t);
  const exported = path.join(temporary, "review.yaml");
  assert.match(run(root, ["--export-review-input", "root", "--output", exported]), /exported/);
  const input = parseYaml(await readFile(exported, "utf8"), (value) => value as ReviewInput);
  assert.equal(input.kind, "review-input");
  assert.equal(input.current.scoped, true);
  input.report.analysis.model = { provider: "test", id: "fixture-model" };
  input.report.analysis.prompt_digest = digest("Read module and record coverage limitations");
  input.manifest.model = input.report.analysis.model;
  input.manifest.prompt_digest = input.report.analysis.prompt_digest;
  await writeFile(exported, stringify(input, { aliasDuplicateObjects: false }));
  assert.match(run(root, ["--import-review", exported, "--build-report"]), /imported/);
  assert.match(run(root, ["--import-review", exported, "--build-report"]), /imported/);
  git(root, ["add", ".archiview"]);
  assert.equal((await checkPreparedIndex(root)).reviews, 1);
  assert.equal(git(root, ["ls-files", ".archiview/snapshots"]).length, 0);
  git(root, ["commit", "-qm", "Portable reports"]);
  const clone = path.join(temporary, "clone");
  git(temporary, ["clone", "-q", root, clone]);
  await rm(root, { recursive: true, force: true });
  const app = await createArchiView({ root: clone });
  const history = await app.reports.list();
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].review_id, input.review_id);
  assert.equal(history.diagnostics.length, 0);
  assert.equal((await checkPreparedIndex(clone)).reviews, 1);
  const historyFile = path.join(".archiview", "work", moduleReportName("root") + ".review.yaml");
  const historyText = await readFile(path.join(clone, historyFile), "utf8");
  const staged = parseYaml(historyText, (value) => value as ReviewHistory);
  const [entry] = staged.entries;
  entry.resolution = { review_ids: ["missing-attempt"], reason: "Разрешить прежнее расхождение." };
  entry.content_digest = entryContentDigest(entry);
  await writeFile(path.join(clone, historyFile), stringify(staged, { aliasDuplicateObjects: false }));
  git(clone, ["add", historyFile]);
  await writeFile(path.join(clone, historyFile), historyText);
  await assert.rejects(checkPreparedIndex(clone), /Unresolved review resolution: missing-attempt/);
});

test("strict YAML rejects non-string keys and non-finite values before hashing", () => {
  assert.throws(() => parseYaml("1: value", (value) => value), /keys must be strings/);
  assert.throws(() => parseYaml("value: .nan", (value) => value), /Unsupported YAML/);
});

test("YAML preserves exactly representable integers and rejects rounding", () => {
  const parse = (source: string) => parseYaml(source, (value) => value);
  assert.deepEqual(parse("[42, 9007199254740992, -9007199254740992]"), [42, 2 ** 53, -(2 ** 53)]);
  for (const number of ["9007199254740993", "-9007199254740993", "0x20000000000001", "0o400000000000000001"]) {
    assert.throws(() => parse("id: " + number), /cannot be represented exactly/);
  }
  assert.equal(parse('"9007199254740993"'), "9007199254740993");
});
