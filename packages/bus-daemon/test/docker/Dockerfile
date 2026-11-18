# Throwaway Linux image for bus install and multi-instance tests (#2793 S0).
# Build context is the repo root; run.sh sets it. Nothing from the host's
# home is ever copied in: Dockerfile.dockerignore is an allowlist.
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

# Fetch from the lockfile alone, so editing sources does not redo the download
# and orphan a large image layer.
COPY --chown=tester:tester package.json pnpm-lock.yaml pnpm-workspace.yaml /repo/
RUN pnpm fetch
COPY --chown=tester:tester . /repo
RUN pnpm install --frozen-lockfile --offline

WORKDIR /repo/packages/bus-daemon
ENV OA_BUS_DOCKER=1
# run.sh passes the test files; it owns the default list.
