#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const execute = promisify(execFile);
const postgresImage = "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";

/** Parse only the service, image, and platform used by the six CI matrix legs. */
export function smokeOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--target", "--image", "--platform"].includes(name) || !value || value.startsWith("-")) {
      throw new Error("Usage: container-smoke.mjs --target <core|browser|cli> --image <tag> --platform <linux/amd64|linux/arm64>");
    }
    if (Object.hasOwn(options, name.slice(2))) throw new Error(`Duplicate option: ${name}`);
    options[name.slice(2)] = value;
  }
  if (!["core", "browser", "cli"].includes(options.target) || !options.image ||
      !["linux/amd64", "linux/arm64"].includes(options.platform)) {
    throw new Error("A supported target, image, and Linux platform are required.");
  }
  return options;
}

/** Invoke Docker without a shell, bounding each operation and its captured output. */
async function docker(args, timeout = 60_000) {
  const result = await execute("docker", args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

/** Capture recent container stdout and stderr without letting failure logs overflow the buffer. */
export async function readContainerLogs(name, executeCommand = execute) {
  const { stdout, stderr } = await executeCommand("docker", ["logs", "--tail", "200", name], {
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024
  });
  return `${stdout}${stderr}`;
}

/** Wait for a genuine container probe while failing immediately if its process exits. */
async function waitForContainer(name, probe) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try { await probe(); return; } catch (error) { lastError = error; }
    if (await docker(["inspect", "--format", "{{.State.Running}}", name]) !== "true") {
      throw new Error(`${name} exited during startup.`, { cause: lastError });
    }
    await sleep(1000);
  }
  throw new Error(`${name} did not become ready within 120 seconds.`, { cause: lastError });
}

/** Start each image through its production entrypoint in a disposable, isolated network. */
export async function runContainerSmoke({ target, image, platform }) {
  const id = `spaceapp-smoke-${randomBytes(6).toString("hex")}`;
  const service = `${id}-${target}`;
  const database = `${id}-postgres`;
  const containers = [];
  const secrets = await mkdtemp(join(tmpdir(), "spaceapp-smoke-secrets-"));
  let networkCreated = false;
  try {
    await docker(["network", "create", id]);
    networkCreated = true;
    if (target !== "cli") {
      // No published port and no operator credentials: trust is confined to this throwaway network.
      containers.push(database);
      await docker(["run", "--detach", "--name", database, "--platform", platform, "--network", id,
        "--network-alias", "db", "--env", "POSTGRES_USER=spaceapp", "--env", "POSTGRES_DB=spaceapp",
        "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--mount",
        `type=bind,src=${resolve("packages/db/migrations")},dst=/migrations,readonly`, postgresImage], 300_000);
      // The init-time PostgreSQL server is socket-only; TCP readiness selects the final server.
      await waitForContainer(database, () => docker(["exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "spaceapp", "-d", "spaceapp"]));
      await writeFile(join(secrets, "database-url"), "postgresql://spaceapp@db:5432/spaceapp");
      if (target === "browser") {
        // Browser Host consumes the schema; only core ships the migration executable.
        await docker(["exec", database, "sh", "-ec",
          'for migration in /migrations/*.sql; do psql -v ON_ERROR_STOP=1 -U spaceapp -d spaceapp -f "$migration"; done']);
      }
    }
    await writeFile(join(secrets, "session-secret"), randomBytes(32).toString("hex"));
    await writeFile(join(secrets, "setup-token"), randomBytes(32).toString("hex"));
    const environment = {
      SPACE_PUBLIC_DISTRIBUTION: "true",
      SPACE_RUNTIME_STORE: "postgres",
      SPACEAPP_WORKFLOWS_ENABLED: "false",
      SPACE_CLI_ENABLED: "false",
      SPACE_BROWSER_SESSIONS_ENABLED: target === "browser" ? "true" : "false",
      SPACE_CLI_HOST_SOCKET: "/run/spaceapp-cli/host.sock",
      SPACE_BROWSER_HOST_SOCKET: "/run/spaceapp-browser/browser-host.sock",
      SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: "4910",
      SPACE_WEB_HOST: "0.0.0.0", SPACE_WEB_PORT: "4911",
      SPACE_API_ORIGIN: "http://127.0.0.1:4910"
    };
    containers.push(service);
    await docker(["run", "--detach", "--name", service, "--platform", platform, "--network", id,
      "--mount", `type=bind,src=${secrets},dst=/run/secrets,readonly`,
      ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]), image]);
    const probe = target === "core"
      ? "const r=await fetch('http://127.0.0.1:4911/readyz');const b=await r.json();if(!r.ok||b.ok!==true)process.exit(1);console.log(JSON.stringify(b));"
      : "const net=await import('node:net');const s=net.createConnection(process.env." +
        (target === "cli" ? "SPACE_CLI_HOST_SOCKET" : "SPACE_BROWSER_HOST_SOCKET") +
        ");s.setTimeout(5000);s.on('connect',()=>s.end());s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1));";
    await waitForContainer(service, () => docker(["exec", "--user", "10001:10001", service,
      "node", "--input-type=module", "-e", probe]));
    if (target === "browser") {
      const page = await docker(["exec", "--user", "10001:10001", service, "/usr/bin/chromium",
        "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--dump-dom",
        "data:text/html,<title>spaceapp-container-smoke</title>"]);
      if (!page.includes("<title>spaceapp-container-smoke</title>")) {
        throw new Error("Headless Chromium did not render the smoke page.");
      }
    }
    if (target === "core") {
      process.stdout.write(`${await docker(["exec", service, "node", "--input-type=module", "-e", probe])}\n`);
    }
    process.stdout.write(`${target} / ${platform}: production entrypoint smoke passed\n`);
  } catch (error) {
    for (const name of containers) {
      process.stderr.write(await readContainerLogs(name).catch(() => "Container logs unavailable."));
    }
    throw error;
  } finally {
    // Only names created by this invocation are removed; never prune an operator's Docker state.
    for (const name of containers.reverse()) await docker(["rm", "--force", "--volumes", name]).catch(() => undefined);
    if (networkCreated) await docker(["network", "rm", id]).catch(() => undefined);
    await rm(secrets, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => runContainerSmoke(smokeOptions(process.argv.slice(2)))).catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
