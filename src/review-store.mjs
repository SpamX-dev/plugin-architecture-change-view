/**
 * Неизменяемые пакеты проверок вне исходников: review.yaml, input.json и снимки.
 * Каталог публикуется целиком после проверки всех ссылок. Импорт и генерация
 * используют одну валидацию; существующий id не перезаписывается.
 */
import { mkdir, readFile, readdir, rename, rm, lstat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stringify } from "yaml";
import { digest, parseYaml, validateReview } from "./formats.mjs";
import { validateReviewBundle } from "./reviews.mjs";

/** Читает ограниченный файл пакета, не следуя файловым ссылкам. */
async function readBounded(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("Invalid review bundle file");
  return readFile(file, "utf8");
}

/** Загружает переносимый пакет анализа и проверяет сохранённые доказательства. */
export async function readReviewBundle(directory) {
  const report = parseYaml(await readBounded(path.join(directory, "review.yaml")), validateReview);
  const manifest = JSON.parse(await readBounded(path.join(directory, "input.json")));
  const current = JSON.parse(await readBounded(path.join(directory, "current.json")));
  const baseline = report.comparison.baseline ? JSON.parse(await readBounded(path.join(directory, "baseline.json"))) : null;
  return validateReviewBundle({ report, manifest, baseline, current });
}

/** Владеет результатами одного проекта; размещение и происхождение задаются SnapshotStore. */
export class ReviewStore {
  constructor(snapshotStore) {
    this.root = snapshotStore.root; this.directory = path.join(snapshotStore.directory, "reviews"); this.snapshotStore = snapshotStore;
  }

  /** Произвольный строковый id отчёта не используется как путь файловой системы. */
  pathFor(id) { return path.join(this.directory, "review-" + digest(id).slice(7)); }

  /** Сохраняет новый результат атомарно, отклоняя коллизию id и чужой проект. */
  async save(bundle) {
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.directory);
    validateReviewBundle(bundle);
    if (bundle.current.root !== this.snapshotStore.snapshotRoot) throw new Error("Foreign review project");
    const id = bundle.report.id;
    await this.snapshotStore.ensureIdentity();
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, ".pending-" + randomUUID());
    await mkdir(temporary);
    try {
      for (const [file, content] of [["review.yaml", stringify(bundle.report, { aliasDuplicateObjects: false })], ["input.json", JSON.stringify(bundle.manifest)],
        ["current.json", JSON.stringify(bundle.current)], ...(bundle.baseline ? [["baseline.json", JSON.stringify(bundle.baseline)]] : [])]) {
        if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("Review bundle exceeds storage limit");
        await writeFile(path.join(temporary, file), content, { flag: "wx" });
      }
      await rename(temporary, this.pathFor(id));
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return id;
  }

  /** История не скрывает повреждённые результаты: ошибка становится диагностикой UI. */
  async list() {
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.directory);
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return { bundles: [], diagnostics: [] }; throw error; }
    const bundles = [];
    const diagnostics = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      try {
        await this.snapshotStore.assertLocation(path.join(this.directory, entry.name));
        const bundle = await readReviewBundle(path.join(this.directory, entry.name));
        if (bundle.current.root !== this.snapshotStore.snapshotRoot) throw new Error("Foreign review project");
        bundles.push(bundle);
      } catch (error) { diagnostics.push(entry.name + ": " + error.message); }
    }
    bundles.sort((a, b) => b.report.analysis.created_at.localeCompare(a.report.analysis.created_at));
    return { bundles, diagnostics };
  }
}
