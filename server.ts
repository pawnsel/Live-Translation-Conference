import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import { createServer } from "http";
import { GoogleGenAI } from "@google/genai";
import { v4 as uuidv4 } from "uuid";

// Helper to get GoogleGenAI client with user token or fallback
function getAiClient(userToken?: string) {
  const key = userToken?.trim() || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("No Gemini API Key provided.");
  }
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

// Fallback phrase dictionary for instant offline / test translation (Thai <-> English)
const QUICK_PHRASES: Record<string, { Thai: string; English: string }> = {
  "hello": { Thai: "สวัสดีครับ/ค่ะ", English: "Hello" },
  "สวัสดี": { Thai: "สวัสดีครับ/ค่ะ", English: "Hello, everyone." },
  "สวัสดีครับ": { Thai: "สวัสดีครับ", English: "Hello and welcome." },
  "สวัสดีค่ะ": { Thai: "สวัสดีค่ะ", English: "Hello and welcome." },
  "welcome": { Thai: "ยินดีต้อนรับสู่การประชุม", English: "Welcome to the conference" },
  "ยินดีต้อนรับ": { Thai: "ยินดีต้อนรับ", English: "Welcome to the meeting." },
  "good morning": { Thai: "สวัสดีตอนเช้าครับ/ค่ะ", English: "Good morning" },
  "good afternoon": { Thai: "สวัสดีตอนบ่ายครับ/ค่ะ", English: "Good afternoon" },
  "thank you": { Thai: "ขอบคุณทุกท่านมากครับ/ค่ะ", English: "Thank you very much" },
  "ขอบคุณครับ": { Thai: "ขอบคุณครับ", English: "Thank you very much." },
  "ขอบคุณค่ะ": { Thai: "ขอบคุณค่ะ", English: "Thank you very much." },
  "ขอบคุณทุกท่าน": { Thai: "ขอบคุณทุกท่าน", English: "Thank you everyone for attending." },
  "artificial intelligence": { Thai: "ปัญญาประดิษฐ์ (AI)", English: "Artificial Intelligence" },
  "ปัญญาประดิษฐ์": { Thai: "ปัญญาประดิษฐ์ (AI)", English: "Artificial Intelligence (AI)" },
  "machine learning": { Thai: "การเรียนรู้ของเครื่อง (Machine Learning)", English: "Machine Learning" },
  "การเรียนรู้ของเครื่อง": { Thai: "การเรียนรู้ของเครื่อง", English: "Machine Learning" },
  "today we will discuss": { Thai: "วันนี้เราจะมาพูดคุยหารือเกี่ยวกับ", English: "Today we will discuss" },
  "วันนี้เราจะมาพูดคุย": { Thai: "วันนี้เราจะมาพูดคุย", English: "Today we are going to discuss" },
  "เริ่มการประชุม": { Thai: "เริ่มการประชุม", English: "Let's start the meeting." },
  "สรุปผลการดำเนินงาน": { Thai: "สรุปผลการดำเนินงาน", English: "Summary of operational performance" }
};

// Main Translation Engine with graceful AI & Dictionary Fallback
async function performTranslation(text: string, config: any, customKey?: string): Promise<{ translatedText: string; isAi: boolean }> {
  const activeKey = customKey?.trim() || process.env.GEMINI_API_KEY;
  
  if (activeKey) {
    try {
      const client = getAiClient(activeKey);
      const prompt = buildTranslationPrompt(config, text);
      const modelToUse = config?.aiModel || "gemini-3.7-flash";
      const response = await client.models.generateContent({
        model: modelToUse,
        contents: prompt,
      });
      const resText = response.text?.trim();
      if (resText) {
        // Strip markdown quotes or conversational prefixes if any
        const cleaned = resText.replace(/^["']|["']$/g, '').trim();
        return { translatedText: cleaned, isAi: true };
      }
    } catch (err: any) {
      console.warn("Gemini translation fallback triggered:", err?.message);
    }
  }

  // Dictionary Lookup Replacement
  let processed = text;
  if (config.dictionaryJson) {
    try {
      const dict = typeof config.dictionaryJson === 'string' ? JSON.parse(config.dictionaryJson) : config.dictionaryJson;
      for (const [src, tgt] of Object.entries(dict)) {
        if (typeof tgt === 'string' && src.trim()) {
          const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          processed = processed.replace(new RegExp(escaped, 'gi'), tgt);
        }
      }
    } catch (e) {}
  }

  // Quick phrase match for Thai & English
  const lower = text.toLowerCase().trim();
  for (const [key, mapping] of Object.entries(QUICK_PHRASES)) {
    if (lower.includes(key.toLowerCase())) {
      const target = config.targetLang === 'English' ? mapping.English : mapping.Thai;
      if (target) return { translatedText: target, isAi: false };
    }
  }

  // Fallback direct translation label
  const isTargetEnglish = config.targetLang === 'English';
  return {
    translatedText: isTargetEnglish ? `[English] ${processed}` : `[ภาษาไทย] ${processed}`,
    isAi: false
  };
}

// Helper to build translation and correction prompt
function buildTranslationPrompt(config: any, text: string) {
  let dictFormatted = "{}";
  if (config.dictionaryJson && config.dictionaryJson.trim()) {
    try {
      dictFormatted = JSON.stringify(JSON.parse(config.dictionaryJson), null, 2);
    } catch {
      dictFormatted = config.dictionaryJson;
    }
  }

  const srcLang = config.sourceLang === "th-TH" ? "Thai (ภาษาไทย)" : "English";
  const tgtLang = config.targetLang === "Thai" ? "Thai (ภาษาไทย)" : "English";

  return `You are an expert AI Realtime Conference Interpreter and Speech-to-Text Post-Corrector.
Your task is to correct any Speech Recognition (ASR) acoustic errors and provide an accurate, fluent translation.

### TRANSLATION TASK:
- Source Language: ${srcLang}
- Target Language: ${tgtLang}

### TERMINOLOGY DICTIONARY & GLOSSARY (Custom Term Mapping):
${dictFormatted}

### INSTRUCTIONS:
1. [ASR Acoustic Error Correction]: If the input speech in ${srcLang} contains misheard words, homophones, speech recognition artifacts, or transliterated jargon, cross-reference with the dictionary and context to restore the intended sentence.
2. [Terminology Enforcement]: Apply any matching dictionary terms consistently between ${srcLang} and ${tgtLang}.
3. [Contextual Translation]: Accurately and fluently translate the sentence from ${srcLang} into natural, professional ${tgtLang}.
4. [Output Format]: Return ONLY the direct translation in ${tgtLang}. Do NOT include explanations, phonetic notes, or quotation marks.

Speech input:
"${text}"`;
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  app.use(express.json());

  // Store server-side secret API Key securely (never transmitted to clients)
  let serverSecretApiKey = "";

  // Store state in memory
  let currentConfig: any = {
    sourceLang: "th-TH",
    targetLang: "English",
    aiModel: "gemini-3.7-flash",
    speechEngine: "google-chirp-asr",
    fontFamily: "sans-serif",
    fontSize: "large",
    dictionaryJson: JSON.stringify({
      "ปัญญาประดิษฐ์": "Artificial Intelligence (AI)",
      "การเรียนรู้ของเครื่อง": "Machine Learning",
      "โมเดลภาษาขนาดใหญ่": "Large Language Models (LLMs)",
      "การประชุมประจำปี": "Annual General Meeting (AGM)",
      "ผลตอบแทนจากการลงทุน": "Return on Investment (ROI)",
      "ตัวชี้วัดความสำเร็จ": "KPI / Key Performance Indicators"
    }, null, 2),
    showOriginal: true,
    showLatency: true,
    chunkSilenceMs: 900
  };

  // Helper to safely serialize config for broadcast (stripping secrets)
  function getSanitizedConfig() {
    return {
      ...currentConfig,
      apiToken: undefined,
      hasCustomToken: Boolean(serverSecretApiKey && serverSecretApiKey.trim())
    };
  }
  
  let transcripts: any[] = [];
  let isMeetingActive = false;

  io.on("connection", (socket) => {
    // Send sanitized state to new clients (No secret API key exposed!)
    socket.emit("config-updated", getSanitizedConfig());
    socket.emit("transcripts-updated", transcripts);
    socket.emit("meeting-status", isMeetingActive);

    // Admin updates config
    socket.on("update-config", (newConfig: any) => {
      // Check if a new API token was submitted
      if (typeof newConfig.apiToken === "string") {
        const trimmed = newConfig.apiToken.trim();
        if (trimmed) {
          serverSecretApiKey = trimmed;
        }
      }
      if (newConfig.clearToken) {
        serverSecretApiKey = "";
      }

      // Save other configuration parameters
      const { apiToken, clearToken, ...safeConfig } = newConfig;
      currentConfig = { ...currentConfig, ...safeConfig };

      // Broadcast sanitized config to all clients
      io.emit("config-updated", getSanitizedConfig());
    });

    // Test token connection
    socket.on("test-token", async (tokenToTest?: string) => {
      try {
        const targetKey = tokenToTest?.trim() || serverSecretApiKey;
        const client = getAiClient(targetKey);
        const res = await client.models.generateContent({
          model: "gemini-3.7-flash",
          contents: "Say 'OK' if working.",
        });
        socket.emit("test-token-result", { 
          success: true, 
          message: targetKey ? "API Key ใช้งานได้สมบูรณ์ (Verified & Active)" : "Default API Key ทำงานปกติ" 
        });
      } catch (err: any) {
        socket.emit("test-token-result", { 
          success: false, 
          message: err.message || "API Key ไม่ถูกต้อง หรือโควต้าหมดอายุ" 
        });
      }
    });

    socket.on("start-meeting", () => {
      isMeetingActive = true;
      transcripts = []; // Clear for new meeting
      io.emit("meeting-status", isMeetingActive);
      io.emit("transcripts-updated", transcripts);
    });

    socket.on("stop-meeting", () => {
      isMeetingActive = false;
      io.emit("meeting-status", isMeetingActive);
    });

    // Ping for live socket latency
    socket.on("ping-check", (clientTimestamp: number) => {
      socket.emit("pong-check", { clientTimestamp, serverTimestamp: Date.now() });
    });

    // Receive recognized text from Admin's microphone or test
    socket.on("new-transcription", async (text) => {
      if (!text || !text.trim()) return;
      
      const startTime = Date.now();
      const id = uuidv4();
      const newItem = {
        id,
        originalText: text.trim(),
        translatedText: "กำลังแปล (Translating...)",
        timestamp: startTime,
        latencyMs: undefined
      };
      transcripts.push(newItem);
      io.emit("transcripts-updated", transcripts);

      try {
        const { translatedText } = await performTranslation(text.trim(), currentConfig, serverSecretApiKey);
        const latencyMs = Date.now() - startTime;
        
        // Update item
        const index = transcripts.findIndex(t => t.id === id);
        if (index !== -1) {
          transcripts[index].translatedText = translatedText;
          transcripts[index].latencyMs = latencyMs;
          io.emit("transcripts-updated", transcripts);
        }
      } catch (error: any) {
        console.error("Translation error:", error);
        const latencyMs = Date.now() - startTime;
        const index = transcripts.findIndex(t => t.id === id);
        if (index !== -1) {
          transcripts[index].translatedText = `(แปลไม่สำเร็จ: ${error?.message || 'AI Error'})`;
          transcripts[index].latencyMs = latencyMs;
          io.emit("transcripts-updated", transcripts);
        }
      }
    });
    
    // Clear transcripts
    socket.on("clear-transcripts", () => {
      transcripts = [];
      io.emit("transcripts-updated", transcripts);
    });

    // Update / Correct a specific transcript item (e.g. translated text)
    socket.on("update-transcript-item", (data: { id: string; translatedText?: string; originalText?: string }) => {
      const index = transcripts.findIndex(t => t.id === data.id);
      if (index !== -1) {
        if (data.translatedText !== undefined) {
          transcripts[index].translatedText = data.translatedText;
        }
        if (data.originalText !== undefined) {
          transcripts[index].originalText = data.originalText;
        }
        transcripts[index].isEdited = true;
        io.emit("transcripts-updated", transcripts);
      }
    });

    // Delete single transcript item
    socket.on("delete-transcript-item", (id: string) => {
      transcripts = transcripts.filter(t => t.id !== id);
      io.emit("transcripts-updated", transcripts);
    });

    // Retranslate single item on demand
    socket.on("retranslate-item", async (data: { id: string; text?: string }) => {
      const index = transcripts.findIndex(t => t.id === data.id);
      if (index === -1) return;
      
      const startTime = Date.now();
      const textToTranslate = data.text || transcripts[index].originalText;
      transcripts[index].translatedText = "กำลังแปล (Translating...)";
      io.emit("transcripts-updated", transcripts);

      try {
        const { translatedText } = await performTranslation(textToTranslate, currentConfig, serverSecretApiKey);
        const latencyMs = Date.now() - startTime;
        const idx = transcripts.findIndex(t => t.id === data.id);
        if (idx !== -1) {
          transcripts[idx].translatedText = translatedText;
          transcripts[idx].latencyMs = latencyMs;
          io.emit("transcripts-updated", transcripts);
        }
      } catch (err: any) {
        const idx = transcripts.findIndex(t => t.id === data.id);
        if (idx !== -1) {
          transcripts[idx].translatedText = `(แปลไม่สำเร็จ: ${err?.message})`;
          io.emit("transcripts-updated", transcripts);
        }
      }
    });
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
