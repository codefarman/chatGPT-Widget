// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

// --- Config ---
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
];

let ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS;
if (process.env.ALLOWED_ORIGINS) {
  try {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    if (Array.isArray(parsed)) ALLOWED_ORIGINS = parsed;
  } catch (e) {
    console.warn("ALLOWED_ORIGINS env parse failed, using defaults.");
  }
}

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) console.warn("Warning: OPENAI_API_KEY is not set.");

const LEAD_WEBHOOK_URL = process.env.LEAD_WEBHOOK_URL || "";
const LEAD_WEBHOOK_TOKEN = process.env.LEAD_WEBHOOK_TOKEN || "";

// --- Express app ---
const app = express();
app.use(express.json());

// --- CORS setup ---
const corsOptions = {
  origin: function (origin, callback) {
    // Allow non-browser requests (Postman/server-to-server)
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

    console.warn("Blocked CORS origin:", origin);
    return callback(new Error("CORS policy: Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions)); // <-- this is sufficient for preflight handling

// Generic lightweight OPTIONS responder (avoids path-to-regexp usage)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    // Let cors middleware handle headers; respond OK for preflight
    return res.sendStatus(200);
  }
  next();
});

// Error handler for CORS and other middleware errors
app.use((err, req, res, next) => {
  if (err && /CORS/i.test(err.message || "")) {
    return res.status(403).json({ error: "CORS error", message: err.message });
  }
  next(err);
});

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// --- /chat endpoint ---
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages (array) required" });
    }

    const systemPrompt = `
You are an empathetic MBA counselor for working professionals.
Always answer in 1 to 5 words only (very short, precise). Do not explain.
End with a tiny follow-up question (1-3 words).
If user shows intent keywords: fees, eligibility, admission, apply, compare, placement, worth
-> when user explicitly confirms interest, collect name then WhatsApp number.
`;

    const payload = [
      { role: "system", content: systemPrompt },
      ...messages.slice(-6),
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: payload,
      max_tokens: 40,
      temperature: 0.2,
    });

    const reply = response?.choices?.[0]?.message?.content ?? "";
    return res.json({ reply: reply.trim() });
  } catch (err) {
    console.error("Chat error:", err?.response?.data ?? err?.message ?? err);
    return res.status(500).json({ error: "chat_error", details: String(err) });
  }
});

// --- /lead endpoint ---
app.post("/lead", async (req, res) => {
  try {
    const { name, phone, firstMessage, conversation, timestamp } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: "name and phone are required" });
    }

    if (!LEAD_WEBHOOK_URL) {
      console.error("LEAD_WEBHOOK_URL not configured.");
      return res.status(500).json({ error: "lead_webhook_not_configured" });
    }

    const cleanPhone = String(phone).replace(/\D/g, "");

    const payload = {
      name,
      phone: cleanPhone,
      firstMessage: firstMessage || "",
      conversation: conversation || [],
      timestamp: timestamp || new Date().toISOString(),
    };

    const url = LEAD_WEBHOOK_TOKEN
      ? `${LEAD_WEBHOOK_URL}${LEAD_WEBHOOK_URL.includes("?") ? "&" : "?"}token=${encodeURIComponent(LEAD_WEBHOOK_TOKEN)}`
      : LEAD_WEBHOOK_URL;

    const axiosResp = await axios.post(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    return res.status(200).json({ success: true, forwarded: true, appsScriptResponse: axiosResp.data || null });
  } catch (err) {
    console.error("Lead forward error:", err?.response?.data ?? err?.message ?? err);
    return res.status(500).json({ error: "lead_forward_error", details: String(err) });
  }
});

// health
app.get("/", (req, res) => res.send({ status: "ok", time: new Date().toISOString() }));

// start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});
