#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

// Historical monolithic image budgets:
// 1.1.3 raised core and browser (998.7 / 1670.6 MiB measured): the current
// application adds production dependencies pdfjs-dist with @napi-rs/canvas
// (81 MiB, API PDF handling), typescript (23 MiB, peer of @t3-oss/env-core) and
// js-tiktoken (22 MiB, Space Gateway token counting).
// 1.1.5 raised core again: linux/arm64 measured 1066.9 MiB and linux/amd64 1045.0 MiB (sqlite3 in the image,
// the 1.1.5 application); the first public release run failed the arm64 build at 1050 MiB.
// 1.1.8 raised core to 1150 MiB for Python with sqlite3 (the Databases tool's SQLite worker): linux/amd64 measured
// 1090.6 MiB with python3 (rc3 without Python: 1057.9 MiB); the trimmed python3-minimal + libpython3-stdlib variant
// measured 1078.6 MiB, 21.4 MiB under the old 1100 MiB, and arm64 ran about 22 MiB above amd64 in 1.1.5.
// 1.1.8 raised browser to 1765 MiB after linux/arm64 measured 1756.3 MiB (amd64 1741.6 MiB).
// Per-service layout at a521ed2, measured by this script in MiB (amd64 / arm64):
// core 269.0 / 267.6; browser 410.6 / 412.3; cli 249.0 / 249.3.
// https://github.com/jeldyf62-lgtm/spaceapp/actions/runs/40394399489
// These measurements precede the 1.1.9 refresh; the refreshed images must be measured again.
// Budgets leave 11.0 / 17.7 / 10.7 MiB above each measured maximum, respectively,
// and stay below issue #64's acceptance ceilings of 850 / 1350 / 1000 MiB.
export const containerImageSizeBudgets = Object.freeze({
  core: 280 * mebibyte,
  browser: 430 * mebibyte,
  cli: 260 * mebibyte
});

/** Compare an inspected image's uncompressed bytes with its service ceiling. */
export function evaluateContainerImageSize({ target, sizeBytes }) {
  const budgetBytes = containerImageSizeBudgets[target];
  if (budgetBytes === undefined) {
    throw new Error(`Unknown container target: ${target}`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Invalid container image size: ${sizeBytes}`);
  }

  const remainingBytes = budgetBytes - sizeBytes;
  return {
    target,
    sizeBytes,
    budgetBytes,
    remainingBytes,
    ok: remainingBytes >= 0
  };
}

/** Read one named command-line option without treating a missing value as zero. */
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Render binary image sizes consistently with Docker inspection measurements. */
function formatMebibytes(bytes) {
  return `${(bytes / mebibyte).toFixed(1)} MiB`;
}

/** Inspect the locally loaded image; command failures propagate to the budget gate. */
export function inspectContainerImageSize(image) {
  const output = execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}", image],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  ).trim();
  return Number(output);
}

/** Enforce a selected service budget and print the actual measured image size. */
export function runContainerImageSizeBudget(args = process.argv.slice(2)) {
  const target = optionValue(args, "--target");
  const image = optionValue(args, "--image");
  if (!target || !image) {
    throw new Error(
      "Usage: container-image-size-budget.mjs --target <core|browser|cli> --image <name:tag>"
    );
  }

  const result = evaluateContainerImageSize({
    target,
    sizeBytes: inspectContainerImageSize(image)
  });
  const summary = [
    `${result.target} image ${image}: ${formatMebibytes(result.sizeBytes)}`,
    `budget ${formatMebibytes(result.budgetBytes)}`,
    `remaining ${formatMebibytes(result.remainingBytes)}`
  ].join("; ");
  if (!result.ok) {
    throw new Error(`Container image size budget exceeded: ${summary}`);
  }
  process.stdout.write(`${summary}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runContainerImageSizeBudget();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
