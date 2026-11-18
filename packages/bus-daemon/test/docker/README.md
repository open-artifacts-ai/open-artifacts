# Docker harness for bus tests

Runs bus tests in a fresh, throwaway Linux container. Used for install and
multi-instance tests (#2793).

## Run

    packages/bus-daemon/test/docker/run.sh [test-file ...]

Paths are relative to `packages/bus-daemon`. With no arguments it runs
`test/docker/two-hubs.smoke.test.ts`. The exit code is vitest's, so CI can
call the script as is. Docker is the only requirement.

## What it isolates

- Each run builds the image and starts a new container with `docker run --rm`.
  The container is removed when the run ends.
- The container has its own empty home (`/home/tester`): no `~/.oa-bus`, no
  `~/.claude*`, no other instance, no other bus.
- No host mounts and no host environment variables are passed in. The repo is
  copied into the image; `node_modules`, `.git` and `.env*` are left out.
- There is no systemd or launchd. The daemon runs as a plain process inside
  the test.
- Tests that need a hub use local fake hubs on 127.0.0.1.

Tests in this folder run only when `OA_BUS_DOCKER=1`, which `run.sh` sets. The
normal host vitest run skips them.

## Limits

- Linux only. The Mac launchd path and Claude Desktop still need a check on a
  real Mac.
- Machine approval needs a browser. These tests use local fake hubs and never
  a person's signed-in browser.
