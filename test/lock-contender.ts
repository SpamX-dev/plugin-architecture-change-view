import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { withFileLock } from "../src/storage/file-lock.js";

const [directory, role] = process.argv.slice(2);
await withFileLock(directory, ".report-store.lock", async () => {
  if (role === "holder") {
    process.send?.("holding");
    // The parent terminates this process while both contenders are waiting.
    await wait(60_000);
    return;
  }
  const marker = path.join(directory, "critical-section");
  await writeFile(marker, String(process.pid), { flag: "wx" });
  await wait(50);
  await rm(marker);
});
