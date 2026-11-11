import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { withFileLock } from "../src/storage/file-lock.js";

test("two processes recover an abandoned lock and enter the critical section exclusively", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  function start(role: string) {
    const child = fork(new URL("./lock-contender.ts", import.meta.url), [directory, role], {
      execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const exit = once(child, "close");
    return { child, exit, diagnostics: () => stderr };
  }
  const holder = start("holder");
  const workers = [holder];
  try {
    const [ready] = await Promise.race([once(holder.child, "message"), holder.exit]);
    assert.equal(ready, "holding", holder.diagnostics());
    const contenders = [start("contender"), start("contender")];
    workers.push(...contenders);
    const deadline = Date.now() + 20_000;
    while ((await readdir(directory)).filter((file) => file.startsWith(".owner-")).length < 2) {
      assert.ok(Date.now() < deadline, "both contenders must reach the live lock");
      await wait(20);
    }
    holder.child.kill();
    for (const worker of contenders) {
      const [code] = await worker.exit;
      assert.equal(code, 0, worker.diagnostics());
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(workers.map((worker) => worker.exit));
  }
});

test("an interrupted recovery can itself be recovered", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = ".lock";
  const owner = { pid: 2147483647, token: "abandoned-owner" };
  const recoveryKey = createHash("sha256").update(JSON.stringify([name, owner.token])).digest("hex");
  await writeFile(path.join(directory, name), JSON.stringify(owner));
  await writeFile(path.join(directory, ".recover-" + recoveryKey), JSON.stringify({ ...owner, token: "abandoned-recovery" }));
  assert.equal(await withFileLock(directory, name, async () => "acquired"), "acquired");
  assert.deepEqual(await readdir(directory), []);
});
