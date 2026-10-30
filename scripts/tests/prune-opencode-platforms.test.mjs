import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneOpenCodePlatforms } from "../prune-opencode-platforms.mjs";

/** Model the pinned installer's hard-linked standalone binary and redundant download. */
async function installation(context) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-opencode-prune-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const platform = join(root, "node_modules", "@opencode", "cli-linux-x64");
  await mkdir(platform, { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@opencode/cli",
    bin: { opencode: "bin/opencode.exe" }, optionalDependencies: { "@opencode/cli-linux-x64": "2.0.32" } }));
  await writeFile(join(platform, "opencode"), "standalone fixture binary");
  await writeFile(join(platform, "LICENSE"), "fixture platform licence");
  await link(join(platform, "opencode"), join(root, "bin", "opencode.exe"));
  return { root, platform };
}

test("pruning keeps the installed hard link and platform licence after removing the download", async context => {
  const { root, platform } = await installation(context);
  assert.equal(await pruneOpenCodePlatforms(root), 1);
  assert.equal(await readFile(join(root, "bin", "opencode.exe"), "utf8"), "standalone fixture binary");
  assert.equal(await readFile(join(root, "platform-licenses", "cli-linux-x64-LICENSE"), "utf8"), "fixture platform licence");
  await assert.rejects(readFile(join(platform, "opencode")), { code: "ENOENT" });
  assert.equal(await pruneOpenCodePlatforms(root), 0);
});

test("pruning fails before deleting packages if the executable is absent", async context => {
  const { root, platform } = await installation(context);
  await rm(join(root, "bin", "opencode.exe"));
  await assert.rejects(pruneOpenCodePlatforms(root), { code: "ENOENT" });
  assert.equal(await readFile(join(platform, "opencode"), "utf8"), "standalone fixture binary");
});

test("pruning rejects a manifest pointing outside its installation", async context => {
  const { root, platform } = await installation(context);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@opencode/cli", bin: { opencode: "../outside" } }));
  await assert.rejects(pruneOpenCodePlatforms(root), /escapes its installation/);
  assert.equal(await readFile(join(platform, "opencode"), "utf8"), "standalone fixture binary");
});
