import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { omitRuntimeFile, stageContainerRuntime } from "../stage-container-runtime.mjs";

/** Create an isolated executable graph with an unused dependency and a runtime asset. */
async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "spaceapp-closure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "source");
  await mkdir(join(root, "node_modules", "used"), { recursive: true });
  await mkdir(join(root, "node_modules", "unused"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "node_modules", "used", "package.json"), '{"name":"used","main":"index.cjs"}');
  await writeFile(join(root, "node_modules", "used", "index.cjs"), 'module.exports = "closure-ok";');
  await writeFile(join(root, "node_modules", "used", "LICENSE"), 'Fixture licence');
  await writeFile(join(root, "node_modules", "unused", "index.js"), 'throw new Error("unused");');
  await writeFile(join(root, "asset.txt"), "asset-ok");
  await writeFile(join(root, "main.mjs"), [
    'import used from "used";',
    'import { readFileSync } from "node:fs";',
    'console.log(used, readFileSync(new URL("./asset.txt", import.meta.url), "utf8"));'
  ].join("\n"));
  return { root, output: join(directory, "deployment") };
}

test("a staged closure executes with its asset and licence, without the original installation", async context => {
  const paths = await fixture(context);
  const result = await stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] });
  assert.ok(result.files > 0);
  assert.equal(await readFile(join(paths.output, "node_modules", "used", "LICENSE"), "utf8"), "Fixture licence");
  await assert.rejects(readFile(join(paths.output, "node_modules", "unused", "index.js")), { code: "ENOENT" });
  await rm(paths.root, { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(paths.output, "main.mjs")], { encoding: "utf8" }).trim(),
    "closure-ok asset-ok");
});

test("a missing runtime dependency fails staging instead of yielding a partial deployment", async context => {
  const paths = await fixture(context);
  await writeFile(join(paths.root, "main.mjs"), 'import "missing-runtime-dependency";');
  await assert.rejects(stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] }),
    /Incomplete cli runtime trace[\s\S]*missing-runtime-dependency/);
});

test("a missing optional import keeps its actual fallback executable", async context => {
  const paths = await fixture(context);
  await writeFile(join(paths.root, "main.mjs"),
    'try { await import("absent-optional-addon"); } catch { console.log("fallback-ok"); }');
  await stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] });
  assert.equal(execFileSync(process.execPath, [join(paths.output, "main.mjs")], { encoding: "utf8" }).trim(), "fallback-ok");
});

test("a required import is not hidden by an unrelated optional dynamic import", async context => {
  const paths = await fixture(context);
  await writeFile(join(paths.root, "main.mjs"),
    'import "missing-required"; try { await import(process.env.OPTIONAL_MODULE); } catch {}');
  await assert.rejects(stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] }),
    /missing-required/);
});

test("a caught import that is rethrown still blocks an incomplete deployment", async context => {
  const paths = await fixture(context);
  await writeFile(join(paths.root, "main.mjs"),
    'export {}; try { await import("missing-required"); } catch (error) { throw error; }');
  await assert.rejects(stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] }),
    /missing-required/);
});

test("a dynamic file URL with encoded spaces remains loadable after staging", async context => {
  const paths = await fixture(context);
  await writeFile(join(paths.root, "module with spaces.mjs"), 'export const value = "url-ok";');
  await writeFile(join(paths.root, "main.mjs"),
    'export {}; const module = await import(new URL("./module with spaces.mjs", import.meta.url).href); console.log(module.value);');
  await stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] });
  await rm(paths.root, { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(paths.output, "main.mjs")], { encoding: "utf8" }).trim(), "url-ok");
});

test("nested and hoisted versions of a production dependency keep their original resolution", async context => {
  const paths = await fixture(context);
  for (const [directory, value] of [[join(paths.root, "node_modules", "shared"), "hoisted"],
    [join(paths.root, "node_modules", "used", "node_modules", "shared"), "nested"]]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), '{"name":"shared","main":"index.cjs"}');
    await writeFile(join(directory, "index.cjs"), `module.exports = "${value}";`);
  }
  await writeFile(join(paths.root, "node_modules", "used", "package.json"),
    '{"name":"used","main":"index.cjs","dependencies":{"shared":"1.0.0"}}');
  await writeFile(join(paths.root, "node_modules", "used", "index.cjs"), 'module.exports = require("shared");');
  await writeFile(join(paths.root, "main.mjs"), 'import nested from "used"; import hoisted from "shared"; console.log(nested, hoisted);');
  await stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] });
  await rm(paths.root, { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(paths.output, "main.mjs")], { encoding: "utf8" }).trim(), "nested hoisted");
});

test("a package can explicitly load an installed polyfill with a builtin module name", async context => {
  const paths = await fixture(context);
  const polyfill = join(paths.root, "node_modules", "buffer");
  await mkdir(polyfill, { recursive: true });
  await writeFile(join(polyfill, "package.json"), '{"name":"buffer","main":"index.cjs"}');
  await writeFile(join(polyfill, "index.cjs"), 'module.exports = "polyfill-ok";');
  await writeFile(join(paths.root, "node_modules", "used", "package.json"),
    '{"name":"used","main":"index.cjs","dependencies":{"buffer":"1.0.0"}}');
  await writeFile(join(paths.root, "node_modules", "used", "index.cjs"), 'module.exports = require("buffer/");');
  await writeFile(join(paths.root, "main.mjs"), 'import value from "used"; console.log(value);');
  await stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] });
  await rm(paths.root, { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(paths.output, "main.mjs")], { encoding: "utf8" }).trim(), "polyfill-ok");
});

test("runtime packages retain declaration files when a compiler reads them as data", async context => {
  const paths = await fixture(context);
  await writeFile(join(paths.root, "node_modules", "used", "runtime.d.ts"), "declaration-data-ok");
  await writeFile(join(paths.root, "node_modules", "used", "index.cjs"),
    'module.exports = require("node:fs").readFileSync(require("node:path").join(__dirname, "runtime.d.ts"), "utf8");');
  await writeFile(join(paths.root, "main.mjs"), 'import value from "used"; console.log(value);');
  await stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] });
  await rm(paths.root, { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(paths.output, "main.mjs")], { encoding: "utf8" }).trim(), "declaration-data-ok");
});

test("workspace links point at the staged package after the source checkout is removed", async context => {
  const paths = await fixture(context);
  const workspace = join(paths.root, "packages", "fixture");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(paths.root, "node_modules", "@space"), { recursive: true });
  await writeFile(join(workspace, "package.json"), '{"name":"@space/fixture","type":"module","exports":"./index.js"}');
  await writeFile(join(workspace, "index.js"), 'export default "workspace-ok";');
  await symlink(workspace, join(paths.root, "node_modules", "@space", "fixture"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(paths.root, "main.mjs"), 'import value from "@space/fixture"; console.log(value);');
  await stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] });
  await rm(paths.root, { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(paths.output, "main.mjs")], { encoding: "utf8" }).trim(), "workspace-ok");
});

test("source and output paths can share a symlinked ancestor", async context => {
  const paths = await fixture(context);
  const aliasRoot = await mkdtemp(join(tmpdir(), "spaceapp-closure-alias-"));
  context.after(() => rm(aliasRoot, { recursive: true, force: true }));
  const ancestor = join(aliasRoot, "checkout");
  await symlink(dirname(paths.root), ancestor, process.platform === "win32" ? "junction" : "dir");
  await stageContainerRuntime({ root: join(ancestor, "source"), output: join(ancestor, "deployment"),
    target: "cli", entrypoints: ["main.mjs"] });
  await rm(paths.root, { recursive: true });
  assert.equal(execFileSync(process.execPath, [join(ancestor, "deployment", "main.mjs")], { encoding: "utf8" }).trim(),
    "closure-ok asset-ok");
});

test("staging refuses to reuse an existing output directory", async context => {
  const paths = await fixture(context);
  await mkdir(paths.output);
  await assert.rejects(stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["main.mjs"] }), { code: "EEXIST" });
});

test("staging rejects an entrypoint outside the source root", async context => {
  const paths = await fixture(context);
  await assert.rejects(stageContainerRuntime({ ...paths, target: "cli", entrypoints: ["../private.mjs"] }),
    /Runtime path escapes/);
});

test("staging rejects an unknown target", async context => {
  const paths = await fixture(context);
  await assert.rejects(stageContainerRuntime({ ...paths, target: "unknown", entrypoints: ["main.mjs"] }),
    /Unknown or empty container target/);
});

test("native prebuild selection retains both supported architectures independently", () => {
  for (const arch of ["x64", "arm64"]) {
    assert.equal(omitRuntimeFile(`node_modules/native/prebuilds/linux-${arch}/addon.node`, "linux", arch), false);
    assert.equal(omitRuntimeFile("node_modules/native/prebuilds/darwin-arm64/addon.node", "linux", arch), true);
    assert.equal(omitRuntimeFile(`node_modules/native/prebuilds/linux-${arch === "x64" ? "arm64" : "x64"}/addon.node`, "linux", arch), true);
    const nativeArch = arch === "x64" ? "x86_64" : "aarch64";
    assert.equal(omitRuntimeFile(`node_modules/@temporalio/core-bridge/releases/${nativeArch}-unknown-linux-gnu/index.node`, "linux", arch), false);
    assert.equal(omitRuntimeFile(`node_modules/@temporalio/core-bridge/releases/${nativeArch}-apple-darwin/index.node`, "linux", arch), true);
  }
  assert.equal(omitRuntimeFile("node_modules/module/index.js.map"), true);
  assert.equal(omitRuntimeFile("node_modules/module/index.d.ts"), false);
  assert.equal(omitRuntimeFile("packages/module/dist/index.d.ts"), true);
  assert.equal(omitRuntimeFile("node_modules/module/index.js"), false);
});
