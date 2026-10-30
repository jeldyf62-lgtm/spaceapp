#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Remove install-only platform packages after OpenCode has installed a standalone executable. */
export async function pruneOpenCodePlatforms(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.name !== "@opencode/cli" || typeof manifest.bin?.opencode !== "string") {
    throw new Error("Expected the pinned @opencode/cli installation.");
  }
  const binary = resolve(root, manifest.bin.opencode);
  const binaryPath = relative(root, binary);
  if (isAbsolute(binaryPath) || binaryPath === ".." || binaryPath.startsWith(`..${sep}`)) {
    throw new Error("OpenCode executable escapes its installation.");
  }
  const info = await lstat(binary);
  if (!info.isFile() || info.size === 0) {
    throw new Error("OpenCode must have installed a nonempty standalone file before pruning.");
  }
  let removed = 0;
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    if (!/^@opencode\/cli-(?:linux|darwin|windows)-[a-z0-9-]+$/.test(name)) continue;
    const platformDirectory = resolve(root, "node_modules", name);
    if (!platformDirectory.startsWith(`${root}${sep}node_modules${sep}`)) {
      throw new Error("OpenCode platform package escapes its installation.");
    }
    let entries;
    try { entries = await readdir(platformDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^(?:licen[cs]e|notice|copying)(?:[._-]|$)/i.test(entry.name)) continue;
      const license = join(root, "platform-licenses", `${name.slice("@opencode/".length)}-${entry.name}`);
      await mkdir(dirname(license), { recursive: true });
      await cp(join(platformDirectory, entry.name), license);
    }
    // postinstall.mjs hard-links or copies this binary into bin/; it is never a symlink.
    await rm(platformDirectory, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  pruneOpenCodePlatforms(process.argv[2]).then(removed => {
    process.stdout.write(`Removed ${removed} install-only OpenCode platform packages.\n`);
  }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
