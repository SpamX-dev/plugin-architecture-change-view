/**
 * Сборка плагина dsh: две половины одного пакета и автономный каталог установки.
 *
 * `dist/dsh/lib/index.js` — хост-половина для Node: cordis-плагин, который регистрирует
 * инструменты, маршруты и скилл. `dist/dsh/lib/client.js` — браузерная половина в
 * формате загрузчика dsh: бандл лишь регистрирует фабрику через
 * `window.__ModuleLoader__.load`, а тело выполняется при первом открытии
 * вкладки.
 *
 * `dist/dsh` — самостоятельный пакет для установки в профиль: только собранные
 * половины, интерфейс, скилл и документы, без зависимостей и devDependencies.
 * Бандл CLI нужен потому, что поручение анализа ссылается на `src/cli.mjs`
 * относительно корня установленного пакета.
 *
 * Пакеты `@deepseek-ai/*` остаются внешними: их предоставляет хост dsh и его
 * таблица платформы, поэтому бандл не несёт вторую копию cordis или React.
 * Остальные зависимости прикладного сервиса встраиваются в `lib/index.js`,
 * чтобы установленный пакет не требовал node_modules.
 *
 * @module plugin-architecture-change-view/scripts/build-dsh
 */

import { build } from "esbuild";
import { buildWeb } from "./build-web.js";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Корень пакета. */
const root = new URL("../", import.meta.url);
await buildWeb(root);
/** Каталог автономного пакета для установки в профиль dsh. */
const distribution = new URL("dist/dsh/", root);
/** Обе половины создаются сразу в пакете: сборка не пишет за пределами dist. */
const output = new URL("lib/", distribution);
/** Идентификатор бандла в загрузчике клиента dsh — имя пакета. */
const metadata = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

/** Общее для Node-бандлов: CJS-зависимости получают рабочий `require`. */
const nodeBanner = {
  js: 'import { createRequire as archiviewCreateRequire } from "node:module";\n' +
    "const require = archiviewCreateRequire(import.meta.url);",
};

await mkdir(output, { recursive: true });

// Хост-половина: один ESM-файл, который загрузчик импортирует по имени пакета.
await build({
  entryPoints: [fileURLToPath(new URL("src/dsh/host.ts", root))],
  outfile: fileURLToPath(new URL("index.js", output)),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@deepseek-ai/*"],
  banner: nodeBanner,
});

// Браузерная половина: CJS-бандл внутри фабрики загрузчика dsh.
const client = await build({
  entryPoints: [fileURLToPath(new URL("src/dsh/client/index.ts", root))],
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2022",
  format: "cjs",
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
});

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(metadata.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${client.outputFiles[0].text}
    return module.exports;
  },
});
`;
await writeFile(new URL("client.js", output), wrapped);

// Автономный пакет установки: CLI кладётся на путь, который ожидает поручение анализа.
await mkdir(new URL("src/", distribution), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("src/archiview/packaged-cli.ts", root))],
  outfile: fileURLToPath(new URL("src/cli.mjs", distribution)),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: nodeBanner,
});
for (const name of ["skills", "docs"]) {
  await cp(new URL(name, root), new URL(name, distribution), { recursive: true });
}
await cp(new URL("dist/web/", root), new URL("web/", distribution), { recursive: true });
await cp(new URL("LICENSE", root), new URL("LICENSE", distribution));
await cp(new URL("cordis.patch.yml", root), new URL("cordis.patch.yml", distribution));

const manifest = {
  name: metadata.name,
  version: metadata.version,
  description: metadata.description,
  type: "module",
  main: "lib/index.js",
  exports: {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
  },
  files: ["lib", "src/cli.mjs", "web", "skills", "docs", "cordis.patch.yml", "LICENSE"],
  dsh: metadata.dsh,
  peerDependencies: metadata.peerDependencies,
  peerDependenciesMeta: metadata.peerDependenciesMeta,
  license: metadata.license,
  engines: metadata.engines,
};
await writeFile(new URL("package.json", distribution), JSON.stringify(manifest, null, 2) + "\n");

process.stdout.write("dsh plugin built: " + fileURLToPath(output) + "\n");
process.stdout.write("dsh package: " + fileURLToPath(distribution) + "\n");
