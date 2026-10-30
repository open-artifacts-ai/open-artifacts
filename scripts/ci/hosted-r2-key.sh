#!/usr/bin/env bash
# Derives the R2 S3 credentials from the Environment's one Cloudflare API token
# and writes <accessKeyId>:<secretAccessKey> to a 0600 file for the oa:hosted
# CLI (hosted-ops.yml, OA_HOSTED_R2_FILE). Per Cloudflare ("Get S3 API
# credentials from an API token", https://developers.cloudflare.com/r2/api/tokens/):
# the access key id is the token's id (GET /user/tokens/verify, result.id) and
# the secret is the SHA-256 hex of the token value. Both halves are masked
# before anything else and never printed. A failed call, a network error or a
# status other than active exits 1 and writes nothing.
# Needs CLOUDFLARE_API_TOKEN (to curl on stdin).
# Usage: scripts/ci/hosted-r2-key.sh <out file>
set +x
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: $0 <out file>" >&2; exit 2; }
out="$1"
# shellcheck source=scripts/ci/hosted-cf.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted-cf.sh"

body="$(cf_ok /user/tokens/verify "verify CLOUDFLARE_API_TOKEN")" || exit 1
id="$(jq -r '.result.id // "" | strings' <<< "$body")" || exit 1
status="$(jq -r '.result.status // "" | strings' <<< "$body")" || exit 1
if command -v sha256sum > /dev/null; then
  secret="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | sha256sum)" || exit 1
else
  secret="$(printf '%s' "$CLOUDFLARE_API_TOKEN" | shasum -a 256)" || exit 1
fi
secret="${secret%% *}"
[ -z "$id" ] || echo "::add-mask::$id"
echo "::add-mask::$secret"
[ "$status" = active ] || { echo "CLOUDFLARE_API_TOKEN is ${status:-of unknown status}, not active" >&2; exit 1; }
[[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo "CLOUDFLARE_API_TOKEN: the token id is not 32 hex" >&2; exit 1; }
[[ "$secret" =~ ^[0-9a-f]{64}$ ]] || { echo "the token hash is not 64 hex" >&2; exit 1; }
umask 077
printf '%s:%s\n' "$id" "$secret" > "$out"
