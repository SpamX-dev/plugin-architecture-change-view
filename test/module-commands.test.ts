import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createArchiViewHttpServer } from "../web/web-backend/web-service/http.js";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import { commitTestFiles, contractYaml, initTestRepository } from "./support.js";

const run = promisify(execFile);
const command = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
async function cli(root: string, ...args: string[]) {
  const { stdout } = await run(process.execPath, [command, "--root", root, ...args], { windowsHide: true });
  return stdout.replaceAll("\r\n", "\n");
}

test("CLI discovers legacy repositories and reads module files and contracts at the requested Git state", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-commands-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, "a");
  for (const name of ["a", "b"]) {
    const repo = path.join(root, name);
    await mkdir(path.join(repo, "src"), { recursive: true });
    initTestRepository(repo);
    await writeFile(path.join(repo, "src/main.js"), "export default 1;");
  }
  const discovered = JSON.parse(await cli(root, "--list-modules")).projects;
  assert.deepEqual(discovered.map((project: {repository: string; hasModuleMap: boolean}) => [project.repository, project.hasModuleMap]),
    [["a", false], ["b", false]]);
  assert.deepEqual(JSON.parse(await cli(root, "--repository", "a", "--module-files", "src")).files, ["src/main.js"]);
  const inventory = JSON.parse(await cli(root, "--inventory"));
  assert.deepEqual(inventory.repositories, ["a", "b"]);
  assert.equal(inventory.sourceFiles, 2);
  await assert.rejects(stat(path.join(a, ".archiview")), { code: "ENOENT" });
  const input = path.join(root, "contract.yaml");
  await writeFile(input, contractYaml("source"));
  await assert.rejects(cli(root, "--write-contract", "source", "--input", input, "--directory", "src"));
  const selected = ["--repository", "a"];
  assert.deepEqual(JSON.parse(await cli(root, ...selected, "--write-contract", "source", "--input", input, "--directory", "src")),
    { id: "source", directory: "src" });
  commitTestFiles(a);
  const { stdout: revision } = await run("git", ["rev-parse", "HEAD"], { cwd: a });
  await writeFile(input, contractYaml("source", "Staged state."));
  await cli(root, ...selected, "--write-contract", "source", "--input", input);
  await run("git", ["add", ".archiview/modules/source.yaml"], { cwd: a });
  await writeFile(input, contractYaml("source", "Working tree."));
  await cli(root, ...selected, "--write-contract", "source", "--input", input);
  assert.equal(await cli(root, ...selected, "--get-contract", "source"), contractYaml("source", "Working tree."));
  assert.equal(await cli(root, ...selected, "--get-contract", "source", "--target", "index"), contractYaml("source", "Staged state."));
  assert.equal(await cli(root, ...selected, "--get-contract", "source", "--target", "git-" + revision.trim()), contractYaml("source"));
  await assert.rejects(cli(root, ...selected, "--write-contract", "source", "--input", input, "--target", "index"));
  assert.deepEqual(JSON.parse(await cli(root, ...selected, "--module-files", "source")).files, ["src/main.js"]);
  const context = JSON.parse(await cli(root, ...selected, "--module-context", "src/main.js"));
  assert.equal(context.contracts.at(-1).contract.id, "source");
  const plan = path.join(root, "plan.yaml");
  await writeFile(plan, JSON.stringify([{ directory: "future", id: "future", title: "Будущий модуль", purpose: "Определять формат." }]));
  assert.deepEqual(JSON.parse(await cli(root, ...selected, "--scaffold", plan)).modules, [{ directory: "future", id: "future" }]);
  assert.match(await cli(root, ...selected, "--get-contract", "future"), /archiview\.prototype: true/);
  const nested = path.join(a, "nested");
  await mkdir(nested);
  initTestRepository(nested);
  await writeFile(path.join(nested, "child.js"), "export default 2;");
  const checkoutInventory = JSON.parse(await cli(root, ...selected, "--inventory"));
  assert.deepEqual(checkoutInventory.repositories, ["a"]);
  assert.equal(checkoutInventory.sourceFiles, 1);
  await assert.rejects(stat(path.join(root, "b/.archiview")), { code: "ENOENT" });
});

test("HTTP writes the same contracts as CLI and rejects stale replacements and cross-origin requests", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-http-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  initTestRepository(root);
  const workspace = await createWorkspaceSession({ root });
  const server = createArchiViewHttpServer(workspace);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const save = (data: object, origin = base) => fetch(base + "/api/contract", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(data),
  });
  try {
    const initial = contractYaml("root");
    assert.equal((await save({ id: "root", directory: ".", text: initial }, "https://example.org")).status, 403);
    assert.equal((await save({ id: "root", directory: ".", text: initial })).status, 200);
    const changed = contractYaml("root", "Changed.");
    assert.equal((await save({ id: "root", text: changed, expectedText: initial })).status, 200);
    assert.equal((await save({ id: "root", text: initial, expectedText: initial })).status, 409);
    const response = await fetch(base + "/api/contract?id=root");
    assert.deepEqual(await response.json(), { id: "root", text: changed });
    assert.equal((await readFile(path.join(root, ".archiview/modules/root.yaml"), "utf8")), changed);
  } finally {
    const closed = once(server, "close");
    server.shutdown();
    await closed;
  }
});
