#!/usr/bin/env bash
# Self-update Galactic Map from GitHub.
#
# Polls the GitHub API for the latest commit on the tracked branch; if it differs from the SHA we last
# deployed, downloads that commit's tarball, extracts it over the deploy dir, and rebuilds. Built for the
# tarball deploy model (repo NOT cloned on the box): your .env and the local Docker infra files
# (Dockerfile, docker-compose.yml, …) aren't in the repo, so extracting in place preserves them.
#
# A failed build leaves the running container untouched (docker compose only swaps on a successful build)
# and we don't record the new SHA, so it retries on the next tick. Run by galacticmap-autoupdate.timer.
#
# Config (env — see galacticmap-autoupdate.service):
#   GH_TOKEN   optional GitHub token — needed only for a private repo or the 5000/hr API rate limit
#   GM_REPO    owner/name        (default nomadsgalaxy/galacticmap)
#   GM_DIR     deploy dir        (default /opt/galactic-map)
#   GM_BRANCH  branch to track   (default main)
#   GM_OWNER   chown files to    (default debian)
set -euo pipefail

REPO="${GM_REPO:-nomadsgalaxy/galacticmap}"
DIR="${GM_DIR:-/opt/galactic-map}"
BRANCH="${GM_BRANCH:-main}"
OWNER="${GM_OWNER:-debian}"
STATE="$DIR/.deployed-sha"
GH_TOKEN="${GH_TOKEN:-}"

# Auth is optional: a public repo works unauthenticated (~60 req/hr). Set GH_TOKEN for a private repo or
# the higher 5000/hr rate limit — the Authorization header is only sent when a token is present.
gh() {
  if [ -n "$GH_TOKEN" ]; then
    curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "X-GitHub-Api-Version: 2022-11-28" "$@"
  else
    curl -fsSL -H "X-GitHub-Api-Version: 2022-11-28" "$@"
  fi
}

# Plain SHA, no jq: the commits/{ref} endpoint returns the bare SHA with this Accept header.
remote=$(gh -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$BRANCH")
current=$(cat "$STATE" 2>/dev/null || echo none)

if [ "$remote" = "$current" ]; then
  echo "up to date @ ${remote:0:8}"
  exit 0
fi

echo "updating ${current:0:8} -> ${remote:0:8}"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
gh -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/tarball/$remote" -o "$tmp"
tar xzf "$tmp" -C "$DIR" --strip-components=1   # overwrites tracked code; .env + infra files survive
chown -R "$OWNER:$OWNER" "$DIR"

cd "$DIR"
docker compose up -d --build                    # build failure aborts here (set -e), before recording SHA
echo "$remote" > "$STATE"
echo "deployed @ ${remote:0:8}"

# Advisory liveness: the app answers 200 on GET / (no /api/health). SHA is already recorded, so this
# never loops a rebuild — it just surfaces a bad deploy in `systemctl status` / journal.
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null http://localhost:3000/; then echo "healthy"; exit 0; fi
  sleep 2
done
echo "WARNING: app not answering on :3000 after deploy ${remote:0:8} — check 'docker compose logs'" >&2
exit 1
