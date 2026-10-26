# Per-service container images

The `core`, `browser`, and `cli` targets retain their production entrypoints and
the shared Node 22 / Debian trixie base. The shared runtime layer contains system
tools, the spaceapp user (uid/gid 10001), npm security patches, Docker helper
scripts, wrapper links, and legal notices. Application code is staged separately
for each target by `scripts/stage-container-runtime.mjs`.

The staging pass traces compiled workspace entrypoints and copies the installed
production package closure without flattening nested dependencies. Workspace
links keep their original resolution. Complete dependency package data remains
available for dynamic loaders and native addons; source maps and foreign native
prebuilds are excluded. Missing required dependencies fail staging.

Core retains the API, worker, web assets, migrations, SQLite worker, owner tools,
backup/restore tools, Gateway bundles/grammars and its local embedding worker,
and bundled skills. CLI retains the pane host, native PTY
addon, credential agent, and skills. Browser retains Browser Host and its own
workspace/dependency graph, Chromium, fonts, and the Xvfb required by default
headed sessions. Core's CLI socket client uses `@space/cli-host/client`, which
does not load the native PTY host.

OpenCode's pinned installer creates a standalone executable by copying or hard
linking a selected platform binary. The CLI build removes the install-only
platform packages after checking that standalone file exists, retains their
licence texts, and runs `opencode --version` after pruning.

## Validation

On a Linux Docker host with buildx and QEMU (or native builders), run all six
image builds, measurements, and production entrypoint checks:

```sh
for arch in amd64 arm64; do
  for target in core browser cli; do
    image="spaceapp-local:$target-$arch"
    docker buildx build --platform "linux/$arch" --target "$target" -t "$image" --load .
    node scripts/container-image-size-budget.mjs --target "$target" --image "$image"
    node scripts/container-smoke.mjs --target "$target" --image "$image" --platform "linux/$arch"
  done
done
node --test scripts/tests/stage-container-runtime.test.mjs scripts/tests/prune-opencode-platforms.test.mjs scripts/tests/container-smoke.test.mjs
npm run check
npm test
npm run build
npm run hygiene:preflight
```

The smoke command creates a disposable network, containers, and temporary
secrets. It publishes no ports and uses no operator state or provider credentials.
Core must run migrations against pgvector PostgreSQL and return `ok: true` from
`/readyz`; workflows are disabled for this small-profile startup check. CLI must
accept a Unix-socket connection. Browser Host must accept a connection against
the migrated schema, then Chromium must render a headless test page as uid 10001.
These checks run for every target and architecture in `containers.yml`.

Record actual image-size output for both architectures before updating the
measurement comments or choosing tighter margins. The issue's hard limits are
850 MiB (core), 1350 MiB (browser), and 1000 MiB (CLI). Staged-directory sizes do
not substitute for Docker image measurements. The existing README disk minima
remain conservative until measured install requirements support a change.

The separate issue #64 full-stack acceptance check requires a Linux host meeting
the launcher's `large` profile minima, including 8 available CPUs and 15 GiB RAM.
Build and tag all three local images with the runtime version expected by the
launcher, use its `--local-images` installation mode with `--profile large` in a
fresh isolated installation, and demonstrate an OpenCode pane and a browser pane
opening a page. Include the real commands and output in the PR. Startup smoke
checks and unit tests do not replace that full-stack run. Security image scans
and the sanitized release build must also be verified before claiming all of the
bounty's acceptance criteria have passed.
