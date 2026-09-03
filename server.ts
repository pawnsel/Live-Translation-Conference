import "dotenv/config";
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { createTokenBroker } from "./server/asrTokenBroker";

async function startServer() {
  const app = express();
  const PORT = 3000;

  const httpServer = createServer(app);

  app.use(express.json());

  const asrBroker = createTokenBroker({
    backendUrl: process.env.ASR_BACKEND_URL || "http://localhost:8765",
    password: process.env.ASR_OPERATOR_PASSWORD || "",
  });

  // The ONE thing this server still protects: the shared operator password.
  // The browser gets a token and talks to Python directly for everything
  // else, because control commands travel over the WebSocket and need a real
  // operator token regardless — proxying the HTTP half would guard nothing.
  app.post("/api/asr/token", async (_req, res) => {
    if (!process.env.ASR_OPERATOR_PASSWORD) {
      res.status(503).json({ error: "ASR_OPERATOR_PASSWORD is not configured on the server" });
      return;
    }
    try {
      const token = await asrBroker.getToken();
      res.json(token);
    } catch (err: any) {
      res.status(503).json({ error: err?.message || "Could not obtain an ASR token" });
    }
  });

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

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
