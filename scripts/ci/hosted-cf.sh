# shellcheck shell=bash
# Sourced by the hosted CI scripts (hosted-resource-ids.sh,
# hosted-turnstile-keys.sh, hosted-r2-key.sh): Cloudflare API reads with the
# one Environment token, CLOUDFLARE_API_TOKEN. The token reaches curl on stdin
# (-K -), never argv, and is never printed. Every failure exits 1. Callers
# add `|| exit 1` to each $(...) of these: bash 3.2 has no inherit_errexit.

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
# Also keeps the curl config line below well-formed (no quote, no newline).
[[ "$CLOUDFLARE_API_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || { echo "CLOUDFLARE_API_TOKEN has unexpected characters" >&2; exit 1; }
CF=https://api.cloudflare.com/client/v4

# cf_ok <path> <what>: the body of GET $CF<path> when .success is true; else
# names <what> with Cloudflare's errors (never a token) and exits 1.
cf_ok() {
  local body
  body="$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" | curl -sS -K - "$CF$1")" ||
    { echo "$2 failed: network error" >&2; exit 1; }
  if [ "$(jq -r '.success' <<< "$body" 2> /dev/null)" != true ]; then
    echo "$2 failed: $(jq -c '.errors' <<< "$body" 2> /dev/null || echo 'unparsable response')" >&2
    exit 1
  fi
  printf '%s' "$body"
}

# list_all <path, ending in ? or &> <per_page> <what>: every page's .result as
# one JSON array. total_pages is trusted when Cloudflare sends it; only without
# it does a short page end the list (as provision's cf.ts).
list_all() {
  local path="$1" per="$2" what="$3" page body all='[]' n pages
  for ((page = 1; page <= 100; page++)); do
    body="$(cf_ok "${path}per_page=$per&page=$page" "$what")" || exit 1
    jq -e '.result | type == "array"' <<< "$body" > /dev/null || { echo "$what failed: no result list" >&2; exit 1; }
    all="$(jq -c --argjson a "$all" '$a + .result' <<< "$body")" || exit 1
    n="$(jq '.result | length' <<< "$body")" || exit 1
    pages="$(jq -r '.result_info.total_pages | if type == "number" then . else "" end' <<< "$body")" || exit 1
    if [ -n "$pages" ]; then
      [ "$page" -lt "$pages" ] || { printf '%s' "$all"; return 0; }
    elif [ "$n" -lt "$per" ]; then
      printf '%s' "$all"
      return 0
    fi
  done
  echo "$what failed: the listing did not end after 100 pages" >&2
  exit 1
}

# one <list> <name field> <name> <id field> <what>: the id of the one entry
# whose name is exactly <name>; 0 or 2+ matches exit 1, naming it.
one() {
  local n
  n="$(jq --arg k "$2" --arg w "$3" '[.[] | select(.[$k] == $w)] | length' <<< "$1")" || exit 1
  [ "$n" = 1 ] || { echo "$5 $3: $n found, want exactly one" >&2; exit 1; }
  jq -r --arg k "$2" --arg w "$3" --arg i "$4" '.[] | select(.[$k] == $w) | .[$i] // ""' <<< "$1"
}
