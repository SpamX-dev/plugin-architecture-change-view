/**
 * Проверка поставки dsh на временной копии настоящих исходников.
 * Сборщик обязан писать только в dist; точки входа исходного npm-пакета и
 * установленной поставки должны разрешаться, а перенесённый CLI — запускаться
 * без node_modules. Общие зависимости подключаются только на время сборки.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";

/**
 * Сохраняет содержимое файлов вне dist и временного подключения зависимостей.
 * Так проверяется вся файловая область сборки, включая неизменность исходников.
 */
async function sourceDigests(root, directory = "") {
  const files = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!directory && ["dist", "node_modules"].includes(entry.name)) continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceDigests(root, relative));
    else files.push([relative, createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex")]);
  }
  return files.sort(([a], [b]) => a.localeCompare(b));
}

test("dsh build stays in dist and produces a relocatable package with working entrypoints", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-dsh-package-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("archiview-dsh-package-"));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = fileURLToPath(new URL("../", import.meta.url));
  for (const name of ["src", "web", "skills", "docs", "package.json", "LICENSE", "cordis.patch.yml"])
    await cp(path.join(source, name), path.join(root, name), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await cp(path.join(source, "scripts/build-dsh.mjs"), path.join(root, "scripts/build-dsh.mjs"));
  await symlink(path.join(source, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  const before = await sourceDigests(root);
  const run = promisify(execFile);
  const build = () => run(process.execPath, [path.join(root, "scripts/build-dsh.mjs")], { cwd: root, windowsHide: true });
  await build();
  assert.deepEqual(await sourceDigests(root), before, "build leaves every path outside dist unchanged");
  await assert.rejects(stat(path.join(root, "lib")), { code: "ENOENT" });

  const distribution = path.join(root, "dist", "dsh");
  const manifest = JSON.parse(await readFile(path.join(distribution, "package.json"), "utf8"));
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.main, "lib/index.js");
  assert.ok(metadata.files.includes("dist/dsh"), "npm publication includes the generated package");
  const require = createRequire(path.join(root, "package.json"));
  assert.equal(require.resolve(metadata.name), path.join(distribution, manifest.main));
  assert.equal(require.resolve(metadata.name + "/client"), path.resolve(distribution, manifest.exports["./client"]));
  for (const target of Object.values(manifest.exports)) assert.ok((await stat(path.resolve(distribution, target))).isFile());

  // Имеющиеся прежние артефакты не должны переписываться при повторной сборке.
  await mkdir(path.join(root, "lib"));
  await writeFile(path.join(root, "lib", "index.js"), "legacy output owned by the fixture");
  const withLegacy = await sourceDigests(root);
  await build();
  assert.deepEqual(await sourceDigests(root), withLegacy);

  // Перенесённый пакет проверяется отдельно от подключённых зависимостей сборщика.
  const relocated = path.join(root, "dist", "Перенесённый пакет с пробелами");
  await cp(distribution, relocated, { recursive: true });
  await rm(path.join(root, "node_modules"));
  const { stdout } = await run(process.execPath, [path.join(relocated, "src", "cli.mjs"), "--help"], { cwd: relocated, windowsHide: true });
  assert.match(stdout, /--export-review-input/);
  assert.match(await readFile(path.join(relocated, "skills", "module-boundaries", "SKILL.md"), "utf8"), /module-boundaries/);
  assert.match(await readFile(path.join(relocated, "web", "archiview", "index.html"), "utf8"), /<html/);
  let registration;
  vm.runInNewContext(await readFile(path.join(relocated, "lib", "client.js"), "utf8"), {
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
  });
  assert.equal(registration.id, metadata.name);
  assert.equal(typeof registration.factory, "function");
});
