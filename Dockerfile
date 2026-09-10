# =============================================================================
#  Live Translation — production image
# =============================================================================
#
#  Two stages. The builder holds the whole toolchain (vite, tailwind, esbuild,
#  every devDependency); the runtime holds a built front end, one bundled
#  server file, and the four packages that file actually requires.
#
#  The one thing to understand before editing this file: VITE_-prefixed
#  variables are BUILD-TIME, not run-time. Vite substitutes them into the
#  JavaScript it emits, so the Supabase URL and anon key are frozen into the
#  bundle here and cannot be changed by `docker run -e` later. Point the image
#  at a different Supabase project and you must rebuild. Everything without
#  the prefix (GEMINI_API_KEY and friends) is read by the server at start-up
#  and belongs in the container's environment instead — never in a layer.
#
#  Build:
#    docker build \
#      --build-arg VITE_SUPABASE_URL=https://xxxx.supabase.co \
#      --build-arg VITE_SUPABASE_ANON_KEY=eyJ... \
#      -t live-translation:latest .
#
#  Building on an Apple Silicon Mac for an x86 server? Add
#  `--platform linux/amd64`, or the image will not start there.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1 — build the front end and bundle the server
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Dependencies first, in their own layer: this is the slow step, and it only
# re-runs when the manifests change rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Read by `vite build` below. Declared here, after the dependency layer, so
# changing a key does not invalidate the npm install cache.
#
# BuildKit warns "SecretsUsedInArgOrEnv" about the anon key here. That warning
# is wrong for this project and should not be "fixed" with a secret mount: the
# anon key is published to every browser that loads the app, by design. What
# guards the data is row-level security in supabase/schema.sql, not the
# secrecy of this string. The key that IS secret, GEMINI_API_KEY, appears
# nowhere in this file.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_ALLOWED_EMAIL_DOMAIN

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_ALLOWED_EMAIL_DOMAIN=$VITE_ALLOWED_EMAIL_DOMAIN

# Fail here rather than at the login screen. Without these two the bundle is
# built with `undefined` baked in, the image looks healthy, and the first user
# to open it is told the app is not configured — with nothing in any log to
# say why.
RUN if [ -z "$VITE_SUPABASE_URL" ] || [ -z "$VITE_SUPABASE_ANON_KEY" ]; then \
      echo "ERROR: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be passed as --build-arg." >&2; \
      echo "       They are compiled into the browser bundle and cannot be set at run time." >&2; \
      exit 1; \
    fi

# Type errors are cheap to catch here and expensive to discover in a meeting.
RUN npm run lint
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Installed from the same lockfile as the builder, so runtime versions are the
# ones that were type-checked and tested. --ignore-scripts because nothing
# here needs a post-install step and running one on a production image is
# gratuitous attack surface.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The build output: the front end in dist/assets, and the whole server bundled
# into dist/server.cjs.
COPY --from=builder /app/dist ./dist

# 0.0.0.0, not the 127.0.0.1 the server defaults to. That default is right on
# a developer's laptop and fatal in a container, where loopback is the
# container's own and nothing outside it can connect. Publish the port to
# 127.0.0.1 on the HOST instead (see docker-compose.yml) to get the same
# protection at the layer that can actually enforce it.
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# /api/health is deliberately outside the auth middleware, so this needs no
# credentials. Written with node's global fetch rather than curl or wget,
# neither of which is worth adding to the image for one request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Drop root. The node image ships this user; nothing here writes to disk, so
# it needs no ownership changes.
USER node

# Exec form, so the server is PID 1 and receives SIGTERM directly — that is
# what its graceful-shutdown handler in server.ts is waiting for. Wrapped in a
# shell it would not be signalled at all, and `docker stop` would sever every
# live session after the ten-second timeout.
CMD ["node", "dist/server.cjs"]
