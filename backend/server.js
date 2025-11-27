// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

// --- Config / env ---
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "https://chat-gpt-widget-three.vercel.app",
  "chat-gpt-widget-three.vercel.app"
];

let ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS;
if (process.env.ALLOWED_ORIGINS) {
  try {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    if (Array.isArray(parsed)) ALLOWED_ORIGINS = parsed;
  } catch (e) {
    console.warn("ALLOWED_ORIGINS parse failed — using defaults.");
  }
}

// Normalize allowed origins into a set of hosts (host:port when present).
function normalizeAllowedHosts(list) {
  const hosts = new Set();
  for (const entry of list) {
    if (!entry) continue;
    try {
      if (/^https?:\/\//i.test(entry)) {
        const u = new URL(entry);
        hosts.add(u.host); // hostname[:port]
      } else {
        // treat as hostname (maybe with port) or origin without scheme
        hosts.add(entry.replace(/\/+$/, ""));
      }
    } catch (e) {
      hosts.add(entry);
    }
  }
  return hosts;
}

const ALLOWED_HOSTS = normalizeAllowedHosts(ALLOWED_ORIGINS);
console.log("Allowed origins (raw):", ALLOWED_ORIGINS);
console.log("Allowed hosts (normalized):", Array.from(ALLOWED_HOSTS));

// --- OpenAI & Lead webhook config ---
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_KEY) console.warn("Warning: OPENAI_API_KEY is not set.");

const LEAD_WEBHOOK_URL = process.env.LEAD_WEBHOOK_URL || "";
const LEAD_WEBHOOK_TOKEN = process.env.LEAD_WEBHOOK_TOKEN || "";

// --- Express app ---
const app = express();
app.use(express.json());

// Helper to extract host from incoming Origin header
function originToHost(origin) {
  if (!origin || typeof origin !== "string") return null;
  try {
    const u = new URL(origin);
    return u.host; // hostname[:port]
  } catch (e) {
    return origin.replace(/\/+$/, "");
  }
}

// --- CORS setup (compare hosts) ---
const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser requests (Postman / server-to-server)
    if (!origin) return callback(null, true);

    const originHost = originToHost(origin);
    if (!originHost) {
      console.warn("Unable to parse origin header:", origin);
      return callback(new Error("CORS origin invalid"));
    }

    if (ALLOWED_HOSTS.has(originHost)) return callback(null, true);
    // Also allow exact origin string if present in allowed origins raw
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

    console.warn("Blocked CORS origin:", origin, "=> host:", originHost);
    return callback(new Error("CORS policy: Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));

// Lightweight OPTIONS responder (avoid path-to-regexp errors)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Error handler for CORS errors
app.use((err, req, res, next) => {
  if (err && /CORS/i.test(err.message || "")) {
    return res.status(403).json({ error: "CORS error", message: err.message });
  }
  next(err);
});

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Robust JSON parser for model output
function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/{[\s\S]*}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

// --- /chat endpoint ---
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages (array) required" });
    }

    const systemPrompt = `
You are an empathetic MBA counselor for working professionals (1–10 years) in India.
Primary goal: help users quickly via concise replies and clickable chips, and provide detailed information when the user explicitly asks for it (lists, comparisons, top college lists, placement details).

OUTPUT STRICTLY as a single JSON object and nothing else. EXACT keys:
{
  "reply": "<string>",      // short OR long depending on user's request (see rules)
  "chips": ["chip1","chip2", ...]  // 0-6 suggested quick-reply chips (short strings)
}

Reply rules:
- If the user's message is a general browsing or quick question, keep "reply" short (1–12 words, ideally 1–5). End with a tiny follow-up (1–3 words) that invites continuation (e.g., "Want options?", "Shall I shortlist?").
- If the user explicitly asks for lists, detailed comparisons, or "give list", "give colleges", "give top colleges in X", "show list", "detailed", then provide a **long, complete, helpful reply** in "reply" (full sentences, multiple lines allowed). In that case the reply may be several sentences and include a short numbered list if helpful.
- Always supply "chips" (0–6 items). Chips should be 1–4 words each and action oriented (e.g., "Fees?", "Top colleges", "Shortlist me", "Scholarship options", "Apply now").
- If input shows conversion intent (contains keywords: fees, apply, admission, eligibility, worth, placement, interested, contact), include at least one conversion chip like "Apply now", "Shortlist me", or "Interested?".
- Do NOT ask for personal contact details inside the JSON reply. The UI will open lead modal when user chooses conversion chip.

Tone and context:
- Audience: working professionals in India, price sensitivity ~ ₹2–4 Lakh for many online options.
- Tone: counselor-like, empathetic, concise unless the user asks for details.

Examples (the model must output JSON only):

1) User: "Fees?"
{
  "reply":"Approx ₹2–4 Lakh. Want top options?",
  "chips":["Top colleges","Scholarship options","Shortlist me"]
}

2) User: "Give top mba colleges in Lucknow"
{
  "reply":"Top MBA colleges in Lucknow:\n1) Institute A — notable for placements and fee ≈ ₹X.\n2) Institute B — strong faculty.\n3) Institute C — affordable option.\nWould you like shortlisted contacts?",
  "chips":["Shortlist me","Fees range","Eligibility"]
}

3) If you cannot produce JSON for some reason, return:
{"reply":"Sorry, try again","chips":["Shortlist me","Apply now"]}

Be careful: output JSON only.
`;

    const payloadMessages = [{ role: "system", content: systemPrompt }, ...messages.slice(-8)];

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: payloadMessages,
      temperature: 0.0,
      max_tokens: 350,
    });

    const raw = response?.choices?.[0]?.message?.content ?? "";
    const parsed = tryParseJsonFromText(raw);

    if (parsed && typeof parsed.reply === "string" && Array.isArray(parsed.chips)) {
      const reply = parsed.reply.trim();
      const chips = parsed.chips.map((c) => String(c).trim()).filter(Boolean).slice(0, 6);
      return res.json({ reply, chips });
    }

    // fallback when model didn't return JSON
    const fallbackReply = (typeof raw === "string" ? raw.split("\n")[0] : "Sorry, try again").trim();
    const defaultChips = ["Apply now"];
    return res.json({ reply: fallbackReply, chips: defaultChips });
  } catch (err) {
    console.error("Chat error:", err?.response?.data ?? err?.message ?? err);
    return res.status(500).json({ error: "chat_error", details: String(err) });
  }
});

// --- /lead endpoint ---
app.post("/lead", async (req, res) => {
  try {
    const { name, phone, firstMessage, conversation, timestamp } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "name & phone required" });
    if (!LEAD_WEBHOOK_URL) return res.status(500).json({ error: "lead_webhook_not_configured" });

    const cleanPhone = String(phone).replace(/\D/g, "");
    const payload = { name, phone: cleanPhone, firstMessage: firstMessage || "", conversation: conversation || [], timestamp: timestamp || new Date().toISOString() };
    const url = LEAD_WEBHOOK_TOKEN ? `${LEAD_WEBHOOK_URL}${LEAD_WEBHOOK_URL.includes("?") ? "&" : "?"}token=${encodeURIComponent(LEAD_WEBHOOK_TOKEN)}` : LEAD_WEBHOOK_URL;

    const axiosResp = await axios.post(url, payload, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
    return res.status(200).json({ success: true, forwarded: true, appsScriptResponse: axiosResp.data || null });
  } catch (err) {
    console.error("Lead forward error:", err?.response?.data ?? err?.message ?? err);
    return res.status(500).json({ error: "lead_forward_error", details: String(err) });
  }
});

// health check
app.get("/", (req, res) => res.send({ status: "ok", time: new Date().toISOString() }));

// start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Allowed origins (raw):", ALLOWED_ORIGINS);
  console.log("Allowed hosts (normalized):", Array.from(ALLOWED_HOSTS));
});
