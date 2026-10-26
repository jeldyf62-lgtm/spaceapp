import assert from "node:assert/strict";
import test from "node:test";
import { readContainerLogs, smokeOptions } from "../container-smoke.mjs";

test("failure diagnostics retain stderr and request only recent container logs", async () => {
  const logs = await readContainerLogs("failed-service", async (command, args) => {
    assert.equal(command, "docker");
    assert.deepEqual(args, ["logs", "--tail", "200", "failed-service"]);
    return { stdout: "startup output\n", stderr: "Error: runtime module missing\n" };
  });
  assert.match(logs, /startup output/);
  assert.match(logs, /Error: runtime module missing/);
});

test("smoke options accept every service and architecture matrix pair", () => {
  for (const target of ["core", "browser", "cli"]) {
    for (const arch of ["amd64", "arm64"]) {
      assert.deepEqual(smokeOptions(["--target", target, "--image", "spaceapp-ci:fixture", "--platform", `linux/${arch}`]),
        { target, image: "spaceapp-ci:fixture", platform: `linux/${arch}` });
    }
  }
});

test("smoke options reject incomplete, ambiguous, and unsupported invocations before Docker runs", () => {
  for (const args of [[], ["--target", "core"], ["--target", "core", "--image", "--privileged"],
    ["--unknown", "value"], ["--target", "core", "--target", "browser"],
    ["--target", "core", "--image", "fixture", "--platform", "windows/amd64"],
    ["--target", "other", "--image", "fixture", "--platform", "linux/amd64"]]) {
    assert.throws(() => smokeOptions(args));
  }
});
