import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { errorDetails } from "../src/runtime/errors.js";

test("process exit codes survive Error and record normalization", async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ["-e", "process.exitCode = 3"]), (cause) => {
    assert.equal(errorDetails(cause).code, 3);
    return true;
  });
  assert.equal(errorDetails({ message: "failed", code: 3 }).code, 3);
  assert.equal(errorDetails({ message: "missing", code: "ENOENT" }).code, "ENOENT");
});
