import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { GoogleGenAI } from "@google/genai";
import { registerGeminiRoutes } from "./server/geminiRoutes";
import type { GenerateContentClient } from "./server/gemini";

async function startServer() {
  const app = express();
  const PORT = 3000;

  const httpServer = createServer(app);

  // Transcript items for a long session add up; the default 100kb JSON body
  // limit is too small for /api/gemini/summarize's full-transcript payload.
  app.use(express.json({ limit: "5mb" }));

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    const genAI = new GoogleGenAI({ apiKey });
    const client: GenerateContentClient = {
      generateContent: (args) =>
        genAI.models.generateContent(args as Parameters<typeof genAI.models.generateContent>[0]),
    };
    registerGeminiRoutes(app, {
      client,
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      summaryModel: process.env.GEMINI_SUMMARY_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash",
    });
  } else {
    // No key configured — fail loudly and specifically rather than letting
    // the client's fetch hit a generic 404 with no explanation.
    const unconfigured = (_req: express.Request, res: express.Response) => {
      res.status(503).json({ error: "GEMINI_API_KEY is not configured on the server" });
    };
    app.post("/api/gemini/transcribe", unconfigured);
    app.post("/api/gemini/summarize", unconfigured);
  }

  // API endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
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
}

startServer();
