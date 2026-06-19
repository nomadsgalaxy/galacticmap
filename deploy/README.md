# Auto-update

Lets an instance keep itself current: a systemd timer polls GitHub every 5 min and, when the tracked
branch has new commits, pulls that commit and rebuilds — no manual deploy.

**How it works.** `autoupdate.sh` asks the GitHub API for the latest commit SHA on `main`. If it differs
from the last deployed SHA (`/opt/galactic-map/.deployed-sha`), it downloads that commit's tarball,
extracts it over the deploy dir (your `.env` and the local Docker infra files aren't in the repo, so they
survive), runs `docker compose up -d --build`, and records the new SHA. A failed build leaves the running
container untouched and retries next tick; a deployed-but-unhealthy app is flagged in the journal.

This matches the manual tarball workflow in `galacticmap-CONNECT.md` — it just automates the trigger.

## Install (one time, on the VM)

From a checkout of the repo on the box (after one manual deploy, that's `/opt/galactic-map`):

```bash
# 1. Script + units.
sudo install -m 755 deploy/autoupdate.sh /usr/local/bin/galacticmap-autoupdate
sudo cp deploy/galacticmap-autoupdate.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload

# 2. (Optional) Token — only for a private repo or the higher 5000/hr API rate limit. A public repo needs
#    none; skip this and the service runs unauthenticated.
sudo install -m 600 /dev/stdin /etc/galactic-map-autoupdate.env <<'EOF'
GH_TOKEN=github_pat_xxxxxxxx
# GM_REPO=nomadsgalaxy/galacticmap   # override for a fork
EOF

# 3. Seed the current SHA so the first tick doesn't rebuild what's already running.
curl -fsSL -H "Accept: application/vnd.github.sha" \
  https://api.github.com/repos/nomadsgalaxy/galacticmap/commits/main | sudo tee /opt/galactic-map/.deployed-sha

# 4. Enable.
sudo systemctl enable --now galacticmap-autoupdate.timer
```

## Operate

```bash
systemctl list-timers galacticmap-autoupdate     # next run
journalctl -u galacticmap-autoupdate -f          # live log / history
sudo systemctl start galacticmap-autoupdate      # update now, don't wait for the timer
sudo systemctl disable --now galacticmap-autoupdate.timer   # pause auto-updates
```

To pin a version, stop the timer; to roll back, write the desired SHA to `/opt/galactic-map/.deployed-sha`
and run the service (or deploy that tarball manually).
