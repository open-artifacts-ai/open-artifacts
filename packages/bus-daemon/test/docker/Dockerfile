# Throwaway Linux image for bus install and multi-instance tests (#2793 S0).
# Build context is the repo root; run.sh sets it. Nothing from the host's
# home is ever copied in: Dockerfile.dockerignore leaves out node_modules,
# .git and build output.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

# A non-root user with an empty home: no ~/.oa-bus, no ~/.claude*.
RUN useradd --create-home --shell /bin/bash tester
WORKDIR /repo
RUN chown tester:tester /repo
USER tester
ENV HOME=/home/tester

COPY --chown=tester:tester . /repo
RUN pnpm install --frozen-lockfile

WORKDIR /repo/packages/bus-daemon
ENV OA_BUS_DOCKER=1
CMD ["pnpm", "exec", "vitest", "run", "test/docker/two-hubs.smoke.test.ts"]
