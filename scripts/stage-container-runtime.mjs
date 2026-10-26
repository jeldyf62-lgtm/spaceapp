#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeFileTrace, resolve as resolveTraceDependency } from "@vercel/nft";
import { createRequire, isBuiltin } from "node:module";
import ts from "typescript";

export const containerEntrypoints = Object.freeze({
  core: [
    "apps/api/dist/server.js", "apps/worker/dist/worker.js", "apps/web/server.mjs",
    "packages/db/dist/migrate.js", "scripts/reset-owner-password.mjs",
    "scripts/rotate-owner-setup-token.mjs", "scripts/portable-backup.mjs",
    "scripts/portable-restore.mjs", "scripts/cli-render-fixture.mjs"
  ],
  browser: ["apps/api/dist/browser-host-main.js"],
  cli: ["packages/cli-host/dist/main.js", "deploy/docker/credential-agent.mjs"]
});

/** Reject paths escaping a deployment root, including absolute trace results. */
function inside(root, file) {
  const destination = resolve(root, file);
  const path = relative(root, destination);
  if (isAbsolute(file) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`Runtime path escapes its root: ${file}`);
  }
  return destination;
}

/** Exclude source maps and native prebuilds that cannot run on this platform. */
export function omitRuntimeFile(file, platform = process.platform, arch = process.arch) {
  const path = file.split(sep).join("/");
  if (/(?:^|\/)\.(?:git|github|env)(?:[./]|$)/.test(path)) return true;
  // These data trees are copied explicitly by the Dockerfile, without analysing their contents as JavaScript.
  if (/^(?:agent-skills|apps\/web\/dist|packages\/db\/migrations)\//.test(path)) return true;
  if (/(?:^|\/)(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[._-][^/]*)?$/.test(path)) return true;
  if (/\.(?:[cm]?js|css)\.map$/.test(path)) return true;
  // Installed compilers may read their declaration files at runtime; keep complete package data.
  if (/\.d\.[cm]?ts$/.test(path) && !path.includes("node_modules/")) return true;
  const prebuild = path.match(/\/prebuilds\/([^/]+)/)?.[1];
  if (prebuild && !prebuild.startsWith(`${platform}-${arch}`)) return true;
  const bridge = path.match(/node_modules\/@temporalio\/core-bridge\/releases\/([^/]+)/)?.[1];
  const triplet = { linux: "unknown-linux-gnu", darwin: "apple-darwin", win32: "pc-windows-msvc" }[platform];
  const nativeArch = { x64: "x86_64", arm64: "aarch64" }[arch];
  if (bridge && triplet && nativeArch && bridge !== `${nativeArch}-${triplet}`) return true;
  if (/node_modules\/@temporalio\/core-bridge\/(?:src|ts|sdk-core|bridge-macros)\//.test(path)) return true;
  return false;
}

/** Recreate links only for workspaces selected by the entrypoint graph. */
async function addWorkspaceLinks(root, files) {
  const workspaces = new Set([...files].map(file => file.split(sep).join("/").match(/^(?:apps|packages)\/[^/]+(?=\/)/)?.[0]).filter(Boolean));
  for (const workspace of workspaces) {
    const manifest = JSON.parse(await readFile(inside(root, join(workspace, "package.json")), "utf8"));
    const link = join("node_modules", manifest.name);
    if (relative(await realpath(inside(root, link)), inside(root, workspace)) !== "") {
      throw new Error(`Workspace link does not match ${workspace}`);
    }
    files.add(join(workspace, "package.json"));
    files.add(link);
  }
}

/** Determine whether a catch block can propagate an unresolved import as an error. */
function containsThrow(node) {
  return ts.isThrowStatement(node) || ts.forEachChild(node, containsThrow) === true;
}

/** Recognise absent optional peers or imports whose own catch block handles absence. */
async function optionalTraceWarning(root, warning) {
  const match = warning.message.match(/^Failed to resolve dependency "([^"]+)":\nCannot find module '[^']+' loaded from (.+)$/);
  if (!match) return false;
  const [, specifier, parent] = match;
  const moduleName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  let directory = dirname(parent);
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.optionalDependencies?.[moduleName] || manifest.peerDependenciesMeta?.[moduleName]?.optional) return true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  const source = ts.createSourceFile(parent, await readFile(parent, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  /** Collect matching static imports, or dynamic requires producing the unresolved name. */
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === specifier) {
      calls.push(node);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && (!ts.isStringLiteralLike(argument) || argument.text === specifier)) calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls.length > 0 && calls.every(call => {
    for (let node = call; node.parent; node = node.parent) {
      if (ts.isTryStatement(node.parent) && node.parent.tryBlock === node && node.parent.catchClause) {
        return !containsThrow(node.parent.catchClause.block);
      }
    }
    return false;
  });
}

/** Find an installed package boundary without relying on its package.json export. */
async function packageDirectory(root, file) {
  let directory = dirname(inside(root, file));
  while (directory !== root && directory !== dirname(directory)) {
    try {
      await readFile(join(directory, "package.json"));
      return directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = dirname(directory);
  }
  throw new Error(`No package boundary for runtime dependency: ${file}`);
}

/** Preserve complete installed production packages, including dynamically loaded data and native code. */
async function addProductionPackages(root, seeds, files) {
  const pending = [...seeds];
  const visited = new Set();
  while (pending.length) {
    const directory = pending.pop();
    if (visited.has(directory)) continue;
    visited.add(directory);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const names = new Set([...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    for (const name of names) {
      let installed;
      // A dependency can explicitly require "buffer/" to select its installed polyfill over Node's builtin.
      const searchName = isBuiltin(name) ? `${name}/` : name;
      for (const search of createRequire(join(directory, "package.json")).resolve.paths(searchName) ?? []) {
        const candidate = join(search, name, "package.json");
        try {
          await readFile(candidate);
          installed = dirname(await realpath(candidate));
          inside(root, relative(root, installed));
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (installed) pending.push(installed);
      else if (!isBuiltin(name) && !manifest.optionalDependencies?.[name] && !manifest.peerDependenciesMeta?.[name]?.optional) {
        throw new Error(`Missing production dependency ${name} required by ${manifest.name}`);
      }
    }
    /** Copy package data conservatively; nested packages have independent dependency boundaries. */
    async function visit(directoryPath) {
      for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
        const path = join(directoryPath, entry.name);
        const file = relative(root, path);
        if (entry.name === "node_modules" || omitRuntimeFile(file)) continue;
        if (entry.isDirectory()) await visit(path);
        else files.add(file);
      }
    }
    await visit(directory);
    // Licence text is deliberately not analysed as JavaScript, but remains in the deployment.
    files.add(relative(root, join(directory, "package.json")));
  }
}

/** Preserve the licence files of each traced dependency alongside its code. */
async function addDependencyLicenses(root, files) {
  for (const file of [...files]) {
    if (!file.split(sep).join("/").includes("node_modules/") || !file.endsWith("package.json")) continue;
    const directory = dirname(file);
    for (const entry of await readdir(inside(root, directory), { withFileTypes: true })) {
      if (/^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(entry.name) && entry.isFile()) {
        files.add(join(directory, entry.name));
      }
    }
  }
}

/** Copy a trace without dereferencing workspace links or letting links escape. */
async function copyRuntimeFile(root, output, file) {
  const source = inside(root, file);
  const destination = inside(output, file);
  await mkdir(dirname(destination), { recursive: true });
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const target = relative(root, await realpath(source));
    const targetDestination = inside(output, target);
    await symlink(process.platform === "win32" ? targetDestination : relative(dirname(destination), targetDestination), destination,
      process.platform === "win32" ? "junction" : undefined);
  } else if (info.isFile()) {
    await cp(source, destination);
  } else {
    throw new Error(`Expected a runtime file or workspace link: ${file}`);
  }
}

/** Stage one entrypoint closure, preserving paths used by Node and native addons. */
export async function stageContainerRuntime({ root, output, target, entrypoints = containerEntrypoints[target] }) {
  if (!Object.hasOwn(containerEntrypoints, target) || !entrypoints?.length) {
    throw new Error(`Unknown or empty container target: ${target}`);
  }
  root = await realpath(resolve(root));
  output = resolve(output);
  // The output is created exclusively: an existing tree must never retain stale dependencies.
  await mkdir(output);
  output = await realpath(output);
  const { fileList, esmFileList, reasons, warnings } = await nodeFileTrace(entrypoints.map(file => inside(root, file)), {
    base: root,
    processCwd: root,
    exportsOnly: true,
    ts: false,
    // Runtime code can dynamically import a URL, including an encoded path containing spaces.
    resolve: (specifier, parent, job, isCjs) => resolveTraceDependency(
      specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier, parent, job, isCjs),
    analysis: { emitGlobs: false, computeFileReferences: true, evaluatePureExpressions: true },
    ignore: file => omitRuntimeFile(file) || /(?:^|\/)node_modules\/(?!@space\/)/.test(file.split(sep).join("/"))
  });
  const unresolved = [];
  for (const warning of warnings) {
    // NFT first attempts CommonJS parsing; a successful ESM retry is not incomplete coverage.
    const scriptParse = warning.message.match(/^Failed to parse (.+) as script:/);
    if (scriptParse && esmFileList.has(relative(root, scriptParse[1]))) continue;
    if (!await optionalTraceWarning(root, warning)) unresolved.push(warning.message);
  }
  if (unresolved.length) {
    throw new Error(`Incomplete ${target} runtime trace:\n${unresolved.join("\n")}`);
  }
  const files = new Set([...fileList].filter(file => !omitRuntimeFile(file)));
  files.add("package.json");
  const packages = new Set();
  for (const [file, reason] of reasons) {
    if (reason.ignored && /(?:^|\/)node_modules\//.test(file.split(sep).join("/")) && !omitRuntimeFile(file)) {
      packages.add(await packageDirectory(root, file));
    }
  }
  await addProductionPackages(root, packages, files);
  await addWorkspaceLinks(root, files);
  await addDependencyLicenses(root, files);
  // Write regular files before workspace links so Windows can create directory junctions too.
  const links = [];
  for (const file of [...files].sort()) {
    if ((await lstat(inside(root, file))).isSymbolicLink()) links.push(file);
    else await copyRuntimeFile(root, output, file);
  }
  for (const file of links) await copyRuntimeFile(root, output, file);
  await writeFile(join(output, "runtime-manifest.json"), `${JSON.stringify({
    target, entrypoints, files: [...files].sort(), optionalWarnings: [...warnings].map(error => error.message)
  }, null, 2)}\n`);
  return { target, files: files.size };
}

/** Build all three independent deployment directories from the compiled checkout. */
async function main(args) {
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("Usage: stage-container-runtime.mjs --output <new-directory>");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = resolve(args[1]);
  await mkdir(output);
  for (const target of Object.keys(containerEntrypoints)) {
    const result = await stageContainerRuntime({ root, output: join(output, target), target });
    process.stdout.write(`${target}: staged ${result.files} runtime files\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
