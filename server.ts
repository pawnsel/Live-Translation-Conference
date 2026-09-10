import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { createServer } from "http";
import { GoogleGenAI } from "@google/genai";
import { registerGeminiRoutes } from "./server/geminiRoutes";
import type { GenerateContentClient } from "./server/gemini";
import { registerGeminiLiveProxy } from "./server/geminiLiveProxy";
import { createSupabaseVerifier, requireApprovedUser, withVerifierCache, type Verifier } from "./server/auth";

async function startServer() {
  const app = express();
  // Overridable so a container or a second instance can be told where to
  // listen without a rebuild. Rejects a non-numeric PORT rather than silently
  // falling back to 3000 and leaving the operator hunting for the port.
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    console.error(`[startup] PORT is not a valid port number: ${process.env.PORT}`);
    process.exit(1);
  }

  const httpServer = createServer(app);

  // Transcript items for a long session add up; the default 100kb JSON body
  // limit is too small for /api/gemini/summarize's full-transcript payload.
  app.use(express.json({ limit: "5mb" }));

  // Every Gemini path costs money, so all of them sit behind an approved
  // account. The VITE_-prefixed names are the same values the browser gets —
  // the prefix only controls what Vite *exposes*, and there is no second copy
  // worth keeping in sync. No service-role key is used: server/auth.ts checks
  // each caller with that caller's own token.
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  let verify: Verifier;
  if (supabaseUrl && supabaseAnonKey) {
    verify = withVerifierCache(createSupabaseVerifier({ url: supabaseUrl, anonKey: supabaseAnonKey }));
  } else {
    // Fail closed. Running with the API endpoints unguarded would hand the
    // Gemini key to anyone who can reach the port.
    console.error(
      "[auth] SUPABASE_URL / SUPABASE_ANON_KEY (or their VITE_ equivalents) are not set — " +
        "every Gemini request and live session will be refused. See .env.example."
    );
    verify = async () => ({ kind: "deny", status: 503, reason: "authentication is not configured on this server" });
  }

  // Registered before the routes themselves so it covers every /api/gemini/*
  // endpoint, including any added later. /api/health stays open: it costs
  // nothing and load balancers need it.
  app.use("/api/gemini", requireApprovedUser(verify));

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const genAI = new GoogleGenAI({ apiKey });
    const client: GenerateContentClient = {
      generateContent: (args) =>
        genAI.models.generateContent(args as Parameters<typeof genAI.models.generateContent>[0]),
    };
    registerGeminiRoutes(app, {
      client,
      summaryModel: process.env.GEMINI_SUMMARY_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash",
    });
    // Live captions for the console — see server/geminiLiveProxy.ts.
    registerGeminiLiveProxy(httpServer, {
      apiKey,
      verify,
      // gemini-3.5-transcribe-live only transcribes and ignores any
      // instruction to translate; this model does both, returning the
      // translation as outputTranscription and the source speech as
      // inputTranscription.
      model: process.env.GEMINI_LIVE_MODEL || "gemini-3.5-live-translate-preview",
      targetLanguageCode: process.env.GEMINI_LIVE_TARGET_LANG || "en",
      sourceLanguageCodes: (process.env.GEMINI_LIVE_SOURCE_LANGS || "th-TH").split(","),
    });
  } else {
    // No key configured — fail loudly and specifically rather than letting
    // the client's fetch hit a generic 404 with no explanation.
    const unconfigured = (_req: express.Request, res: express.Response) => {
      res.status(503).json({ error: "GEMINI_API_KEY is not configured on the server" });
    };
    app.post("/api/gemini/summarize", unconfigured);
  }

  // API endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Past this point every remaining route falls through to the SPA, which
  // answers 200 with index.html. That is the right answer for /admin, and a
  // baffling one for a mistyped /api path — a fetch would parse HTML as JSON
  // and report something unrelated. Anything under /api that got this far
  // does not exist; say so.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'no such endpoint' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    // Imported here rather than at the top of the file: this is the only
    // branch that needs Vite, and a static import makes the production
    // bundle require the whole toolchain at boot — so a lean runtime image
    // (or a `npm prune --omit=dev`) would crash before serving a byte.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.DIST_PATH || path.join(process.cwd(), 'dist');
    const indexPath = path.join(distPath, 'index.html');
    // The front end is built separately from the server bundle, and running
    // `node dist/server.cjs` from the wrong directory is the easy mistake.
    // Fail at boot with the path we looked in, rather than serving 404s that
    // look like a routing bug.
    if (!fs.existsSync(indexPath)) {
      console.error(
        `[startup] no built front end at ${indexPath}. Run \`npm run build\` first, ` +
          `or point DIST_PATH at the build output.`
      );
      process.exit(1);
    }
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(indexPath);
    });
  }

  // This is a single-operator, single-tab local tool (no multi-session
  // registry, no shared backend) — it has no business being reachable from
  // the network. Bind to loopback only unless a developer explicitly opts
  // into LAN/remote access via HOST.
  const HOST = process.env.HOST || "127.0.0.1";
  httpServer.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });

  // `docker stop` and systemd both send SIGTERM, and Node's default handler
  // exits at once — cutting every open live session mid-sentence. Stop
  // accepting new connections, give the in-flight ones a moment to close
  // cleanly, then go. The timer is unref'd so a quiet server still exits
  // immediately.
  const SHUTDOWN_GRACE_MS = 10_000;
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, closing`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => {
      console.warn(`[shutdown] connections still open after ${SHUTDOWN_GRACE_MS}ms, exiting anyway`);
      process.exit(0);
    }, SHUTDOWN_GRACE_MS).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer();
