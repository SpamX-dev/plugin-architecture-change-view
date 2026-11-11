#!/usr/bin/env node
import { runCli } from "./command.js";

// Source launch compiles the UI only when the selected operation starts HTTP.
await runCli(async () => {
  const { buildWeb } = await import("../../scripts/build-web.js");
  await buildWeb();
});
