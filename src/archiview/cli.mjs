#!/usr/bin/env node
/**
 * Запускает ArchiView на loopback-интерфейсе для одного локального проекта.
 * --state-dir позволяет выбрать внешнее хранилище снимков; --port 0 выдаёт
 * свободный порт. Остановка закрывает только собственный HTTP-сервер.
 */
import { parseArgs } from "node:util";
import { createArchiView } from "./http.mjs";
import { readReviewBundle } from "../review-store.mjs";

/** Аргументы локального приложения, не влияющие на настройки MCP-сервера. */
const { values } = parseArgs({ options: {
  root: { type: "string" }, port: { type: "string", default: "4317" },
  "state-dir": { type: "string" }, help: { type: "boolean", short: "h" },
  "import-review": { type: "string" },
} });
if (values.help) {
  process.stdout.write("ArchiView — archiview [--root DIR] [--port 4317] [--state-dir DIR] [--import-review BUNDLE_DIR]\n");
} else {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be between 0 and 65535");
  }
  const { server, root, reviews } = await createArchiView({
    root: values.root ?? process.cwd(), stateDirectory: values["state-dir"],
  });
  if (values["import-review"]) {
    await reviews.save(await readReviewBundle(values["import-review"]));
    process.stdout.write("Review imported\n");
  }
  server.on("error", (error) => {
    process.stderr.write("ArchiView: " + error.message + "\n");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("ArchiView Local: http://127.0.0.1:" +
      server.address().port + "\nProject: " + root + "\n");
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit()));
  }
}
