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
async function sourceDigests(root: string, directory = ""): Promise<[string, string][]> {
  const files: [string, string][] = [];
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
  for (const name of ["src", "web", "skills", "docs", "tsconfig.json", "package.json", "LICENSE", "cordis.patch.yml"])
    await cp(path.join(source, name), path.join(root, name), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  for (const name of ["build-dsh.ts", "build-web.ts", "distribution.ts"]) await cp(path.join(source, "scripts", name), path.join(root, "scripts", name));
  await symlink(path.join(source, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  const before = await sourceDigests(root);
  const run = promisify(execFile);
  const build = () => run(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "scripts/build-dsh.ts")], { cwd: root, windowsHide: true });
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
  for (const target of Object.values(manifest.exports as Record<string, string>)) assert.ok((await stat(path.resolve(distribution, target))).isFile());

  // Имеющиеся прежние артефакты не должны переписываться при повторной сборке.
  await mkdir(path.join(root, "lib"));
  await writeFile(path.join(root, "lib", "index.js"), "legacy output owned by the fixture");
  const withLegacy = await sourceDigests(root);
  await writeFile(path.join(distribution, "docs", "obsolete.md"), "stale package content");
  await writeFile(path.join(root, "dist/web/obsolete.mjs"), "stale asset");
  await build();
  await assert.rejects(stat(path.join(distribution, "docs", "obsolete.md")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(distribution, "web", "obsolete.mjs")), { code: "ENOENT" });
  assert.deepEqual(await sourceDigests(root), withLegacy);

  // Перенесённый пакет проверяется отдельно от подключённых зависимостей сборщика.
  const relocated = path.join(root, "dist", "Перенесённый пакет с пробелами");
  await cp(distribution, relocated, { recursive: true });
  await rm(path.join(root, "node_modules"));
  const { stdout } = await run(process.execPath, [path.join(relocated, "src", "cli.mjs"), "--help"], { cwd: relocated, windowsHide: true });
  assert.match(stdout, /--export-review-input/);
  assert.match(await readFile(path.join(relocated, "skills", "module-boundaries", "SKILL.md"), "utf8"), /module-boundaries/);
  assert.match(await readFile(path.join(relocated, "web", "archiview", "index.html"), "utf8"), /<html/);
  let registration: { id: string; factory: unknown } | undefined;
  vm.runInNewContext(await readFile(path.join(relocated, "lib", "client.js"), "utf8"), {
    window: { __ModuleLoader__: { load(value: { id: string; factory: unknown }) { registration = value; } } },
  });
  assert.ok(registration);
  assert.equal(registration.id, metadata.name);
  assert.equal(typeof registration.factory, "function");

  // Проверяем настоящий npm lifecycle установки в отдельный профиль без загрузки клиента dsh.
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const npm = (args: string[], cwd: string) => run(process.execPath, [npmCli, ...args], { cwd, windowsHide: true });
  const packed = JSON.parse((await npm(["pack", "--json", "--ignore-scripts"], relocated)).stdout) as { filename: string }[];
  const profile = path.join(root, "dist", "Изолированный профиль npm");
  await mkdir(profile);
  await writeFile(path.join(profile, "package.json"), JSON.stringify({ name: "archiview-install-fixture", private: true }));
  await npm(["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", path.join(relocated, packed[0].filename)], profile);
  const installedRequire = createRequire(path.join(profile, "package.json"));
  const installedHost = installedRequire.resolve(metadata.name);
  const installedClient = installedRequire.resolve(metadata.name + "/client");
  const installedRoot = path.dirname(path.dirname(installedHost));
  assert.equal(installedClient, path.join(installedRoot, "lib", "client.js"));
  assert.ok(installedHost.startsWith(path.join(profile, "node_modules") + path.sep));
  const installedCli = await run(process.execPath, [path.join(installedRoot, "src", "cli.mjs"), "--help"], { cwd: profile, windowsHide: true });
  assert.match(installedCli.stdout, /--export-review-input/);
});

test("the root npm package includes every generated executable and plugin entry", { timeout: 60_000 }, async () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const metadata = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as {
    bin: Record<string, string>; main: string; exports: Record<string, string>;
  };
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const { stdout } = await promisify(execFile)(process.execPath, [npmCli, "pack", "--json", "--dry-run", "--ignore-scripts"], { cwd: source, windowsHide: true });
  const packed = JSON.parse(stdout) as { files: { path: string }[] }[];
  const paths = new Set(packed[0].files.map((file) => file.path));
  for (const target of [...Object.values(metadata.bin), metadata.main, ...Object.values(metadata.exports)]) {
    assert.ok(paths.has(target.replace(/^\.\//, "")), `npm publication must include ${target}`);
  }
});
