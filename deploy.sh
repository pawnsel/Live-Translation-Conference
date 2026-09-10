#!/usr/bin/env bash
# =============================================================================
#  Live Translation — deploy to the organisation's server
# =============================================================================
#
#  Run from your laptop, with the VPN already up. Configure it once by copying
#  deploy.conf.example to deploy.conf and filling in the host.
#
#      ./deploy.sh                 # sync the source, build and restart there
#      ./deploy.sh --mode image    # build here, ship the image over SSH
#      ./deploy.sh --skip-checks   # skip the local lint/test gate
#      ./deploy.sh --logs          # just follow the server's log
#
#  Two modes, because which one works depends on the server, not on taste:
#
#    rsync  (default) copies the source and builds on the server. Simplest,
#           and the image is built for the server's own architecture — but the
#           server needs to reach the npm registry.
#
#    image  builds here and pipes the image over the SSH connection. Use it
#           when the server has no outbound internet. Slower (a few hundred
#           MB per deploy) and it must be told the server's architecture,
#           which is why DOCKER_PLATFORM exists below.
# =============================================================================

set -euo pipefail

cd "$(dirname "$0")"

# --- configuration -----------------------------------------------------------

# deploy.conf is git-ignored and holds the host. Environment variables win over
# it, so CI or a one-off can override without editing the file.
if [[ -f deploy.conf ]]; then
  # shellcheck disable=SC1091
  source deploy.conf
fi

SSH_HOST="${SSH_HOST:-}"                              # e.g. deployer@10.0.12.34
REMOTE_DIR="${REMOTE_DIR:-/opt/live-translation}"
SSH_OPTS="${SSH_OPTS:-}"
# Almost every server is x86_64 while recent Macs are arm64. An image built on
# the wrong one starts and then dies with "exec format error", so --mode image
# always builds for this target explicitly rather than inheriting the laptop's.
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
IMAGE_NAME="${IMAGE_NAME:-live-translation:latest}"

MODE="rsync"
SKIP_CHECKS=0
LOGS_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)        MODE="${2:-}"; shift 2 ;;
    --skip-checks) SKIP_CHECKS=1; shift ;;
    --logs)        LOGS_ONLY=1; shift ;;
    -h|--help)     sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# --- helpers -----------------------------------------------------------------

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# shellcheck disable=SC2086
remote() { ssh $SSH_OPTS "$SSH_HOST" "$@"; }

[[ -n "$SSH_HOST" ]] || die "SSH_HOST is not set. Copy deploy.conf.example to deploy.conf and fill it in."

if [[ "$LOGS_ONLY" == 1 ]]; then
  remote "cd '$REMOTE_DIR' && docker compose logs -f --tail=200 app"
  exit 0
fi

# --- 1. local checks ---------------------------------------------------------
#
# The build inside the image runs `npm run lint` too, but the tests only run
# here — and a failing test is much cheaper to see now than after the image is
# on the server. Deliberately not skipped by default.

if [[ "$SKIP_CHECKS" == 0 ]]; then
  say "Local checks (skip with --skip-checks)"
  npm run lint
  npm test
else
  warn "skipping lint and tests"
fi

if git rev-parse --git-dir >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "working tree has uncommitted changes — they WILL be deployed"
  fi
  say "Deploying $(git rev-parse --short HEAD) on $(git branch --show-current)"
fi

# --- 2. reachability ---------------------------------------------------------

say "Checking $SSH_HOST"
remote "true" || die "cannot reach $SSH_HOST over SSH. Is the VPN connected?"
remote "command -v docker >/dev/null" || die "docker is not installed on the server"
# Compose v2 is a CLI plugin, not a package `docker` pulls in — the distro
# docker.io packages ship without it, which is the usual reason to land here.
# v1 (the Python `docker-compose`) is not a fallback: it reads a file with no
# `version:` key as the long-dead v1 format, where `services:` is not even a
# recognised key, so docker-compose.yml would fail in a way that looks like a
# syntax error rather than a missing tool.
if ! remote "docker compose version >/dev/null 2>&1"; then
  printf '\033[1;31merror: docker compose (v2) is not available on %s\033[0m\n\n' "$SSH_HOST" >&2
  echo "  What the server actually has:" >&2
  remote "
    echo -n '    docker:         '; docker --version 2>&1 | head -1
    echo -n '    docker-compose: '; (docker-compose --version 2>&1 | head -1) || echo 'not installed'
    echo -n '    os:             '; (. /etc/os-release 2>/dev/null && echo \"\$PRETTY_NAME \$(uname -m)\") || uname -srm
  " >&2 || true
  cat >&2 <<EOF

  Install the plugin on the server, then run this again.

  Preferred — one static binary, no sudo, and not dependent on the distro's
  apt/dnf sources actually carrying this package (many don't — "Unable to
  locate package docker-compose-plugin" means exactly that; do not add
  Docker's own apt repo just to get it):

    mkdir -p ~/.docker/cli-plugins
    curl -fsSL -o ~/.docker/cli-plugins/docker-compose \\
      "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-\$(uname -m)"
    chmod +x ~/.docker/cli-plugins/docker-compose
    docker compose version

  No outbound internet from the server — download that same file on your
  laptop and copy it over:

    scp docker-compose-linux-\$(uname -m) $SSH_HOST:~/.docker/cli-plugins/docker-compose

  Have sudo and the distro's own package happens to carry it:

    sudo apt-get update && sudo apt-get install -y docker-compose-plugin   # Debian/Ubuntu
    sudo dnf install -y docker-compose-plugin                              # RHEL/Rocky/Alma

EOF
  exit 1
fi

# The .env on the server holds the Gemini key and is never copied from here —
# secrets do not travel with the source. Refuse to continue without it rather
# than deploying a container that fails closed on its first request.
if ! remote "test -f '$REMOTE_DIR/.env'"; then
  cat >&2 <<EOF

error: $REMOTE_DIR/.env does not exist on the server.

  It is intentionally not deployed from here — it holds the Gemini API key.
  Create it once, by hand:

    ssh $SSH_HOST
    sudo mkdir -p $REMOTE_DIR && sudo chown \$USER $REMOTE_DIR
    # paste the contents of .env.deploy.example, filled in:
    nano $REMOTE_DIR/.env
    chmod 600 $REMOTE_DIR/.env

EOF
  exit 1
fi

# --- 3. ship -----------------------------------------------------------------

case "$MODE" in
  rsync)
    say "Syncing source to $SSH_HOST:$REMOTE_DIR"
    # --delete keeps the remote tree honest: a file deleted here disappears
    # there too, so a removed module cannot linger and get bundled.
    # .env is excluded in BOTH directions of intent — never overwrite the
    # server's copy, never upload the laptop's development one.
    # macOS 15 ships openrsync in place of GNU rsync, and it has no --info=
    # option at all — the deploy dies at the usage message before a byte
    # moves. --stats exists in both and reports the same thing, just more
    # verbosely on GNU, so ask which one we have rather than assume.
    if rsync --info=help >/dev/null 2>&1; then
      RSYNC_STATS=(--info=stats1)
    else
      RSYNC_STATS=(--stats)
    fi

    rsync -az --delete "${RSYNC_STATS[@]}" \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude 'dist' \
      --exclude 'coverage' \
      --exclude '.env' \
      --exclude '.env.*' \
      --exclude 'deploy.conf' \
      --exclude '.worktrees' \
      --exclude '*.log' \
      ${SSH_OPTS:+-e "ssh $SSH_OPTS"} \
      ./ "$SSH_HOST:$REMOTE_DIR/"

    say "Building and restarting on the server"
    # --wait blocks until the container reports healthy, so a broken deploy
    # fails here instead of looking like it succeeded.
    remote "cd '$REMOTE_DIR' && docker compose up -d --build --wait"
    ;;

  image)
    say "Building $IMAGE_NAME locally for $DOCKER_PLATFORM"
    # The VITE_ values are compiled into the bundle, so they must be known
    # now, at build time — read them from the server's .env, which is the one
    # that is actually authoritative.
    VITE_URL="$(remote "grep -E '^VITE_SUPABASE_URL=' '$REMOTE_DIR/.env' | head -1 | cut -d= -f2- | tr -d '\"'" )"
    VITE_KEY="$(remote "grep -E '^VITE_SUPABASE_ANON_KEY=' '$REMOTE_DIR/.env' | head -1 | cut -d= -f2- | tr -d '\"'" )"
    VITE_DOMAIN="$(remote "grep -E '^VITE_ALLOWED_EMAIL_DOMAIN=' '$REMOTE_DIR/.env' | head -1 | cut -d= -f2- | tr -d '\"'" || true)"
    [[ -n "$VITE_URL" && -n "$VITE_KEY" ]] \
      || die "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set in $REMOTE_DIR/.env"

    docker build \
      --platform "$DOCKER_PLATFORM" \
      --build-arg "VITE_SUPABASE_URL=$VITE_URL" \
      --build-arg "VITE_SUPABASE_ANON_KEY=$VITE_KEY" \
      --build-arg "VITE_ALLOWED_EMAIL_DOMAIN=$VITE_DOMAIN" \
      -t "$IMAGE_NAME" .

    say "Shipping the image over SSH (this is the slow part)"
    # Piped rather than written to a file at either end: nothing to clean up,
    # and no need for a few hundred MB of free space on the laptop.
    # shellcheck disable=SC2086
    docker save "$IMAGE_NAME" | gzip -1 | ssh $SSH_OPTS "$SSH_HOST" "gunzip | docker load"

    # docker-compose.yml is still needed there to run it, and it is small.
    # shellcheck disable=SC2086
    scp $SSH_OPTS docker-compose.yml "$SSH_HOST:$REMOTE_DIR/docker-compose.yml"

    say "Restarting on the server"
    # No --build: the image was just loaded, and rebuilding would need the
    # source that this mode deliberately does not ship.
    remote "cd '$REMOTE_DIR' && docker compose up -d --no-build --wait"
    ;;

  *)
    die "unknown --mode '$MODE' (expected 'rsync' or 'image')"
    ;;
esac

# --- 4. verify ---------------------------------------------------------------
#
# From inside the server, because the container is published on 127.0.0.1
# only. This checks the app, not the reverse proxy — if this passes and the
# browser still cannot reach the site, the problem is nginx or TLS.

say "Verifying"
if remote "curl -fsS --max-time 10 http://127.0.0.1:\${APP_PORT:-3000}/api/health"; then
  printf '\n'
else
  remote "cd '$REMOTE_DIR' && docker compose logs --tail=50 app" || true
  die "the container is up but /api/health did not answer — see the log above"
fi

# An old image per deploy adds up on a server with a modest disk.
say "Pruning images superseded by this deploy"
remote "docker image prune -f >/dev/null 2>&1" || warn "could not prune old images"

say "Done. Follow the log with: ./deploy.sh --logs"
