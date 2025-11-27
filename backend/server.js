// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();

// --- Config / env ---
const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:3000", "http://localhost:3000"];
let ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS;
if (process.env.ALLOWED_ORIGINS) {
  try {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    if (Array.isArray(parsed)) ALLOWED_ORIGINS = parsed;
  } catch (e) {
    console.warn("ALLOWED_ORIGINS parse failed — using defaults.");
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
    // allow non-browser requests (Postman / server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    console.warn("Blocked CORS origin:", origin);
    return callback(new Error("CORS policy: Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));

// Lightweight OPTIONS responder to avoid path-to-regexp issues
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

// --- Utils: parse JSON robustly from model text ---
function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  // Direct parse
  try {
    const j = JSON.parse(text);
    return j;
  } catch (e) {
    // Try to extract first {...} block
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

// --- /chat endpoint (returns { reply, chips }) ---
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages (array) required" });
    }

    // Conversion-focused system prompt asking for strict JSON output
    const systemPrompt = `
You are an empathetic MBA counselor for working professionals (1–10 years experience) in India. 
Primary goal: help users quickly (via short replies + clickable chips) and guide genuinely interested users to request a shortlist (lead capture).

Constraints & output format (STRICT JSON ONLY):
Return **exactly one JSON object** and nothing else. Do NOT include commentary or explanation outside the JSON.
The JSON must have exactly two keys:
{
  "reply": "<short reply string>",
  "chips": ["chip1","chip2","chip3", ...]
}

Rules for "reply":
- Keep it concise: 1–12 words (preferably 1–5). Very direct and helpful.
- Tone: counselor-like — empathetic, trustworthy, calm, helpful.
- Always end the reply with a tiny follow-up (1–3 words) that invites the user to continue (e.g., "Want options?", "Want fees?", "Shall I shortlist?").
- If a numeric figure is given, use INR and approximate (e.g., "≈ ₹2–4 Lakh"). Avoid long explanations.

Rules for "chips":
- Provide 2–6 suggested chips (quick replies) for the user to tap next.
- Chips should be 1–4 words each, action-oriented and specific (examples: "Fees?", "Top colleges", "Duration", "Apply now", "Scholarship options", "Shortlist me").
- Make chips progressively deeper: first-level chips are broad (e.g., "Fees?", "Top colleges"); deeper chips should be focused (e.g., "Fees — 1-year", "Top online colleges", "Weekend batches", "Scholarship eligibility").
- If user expresses conversion intent (contains keywords: fees, apply, admission, eligibility, worth, placement, interested, contact), include at least one conversion chip such as "Interested?" or "Apply now" or "Shortlist me".
- If user chooses an Apply/Interested chip, the UI will open a lead modal. Do NOT ask for name/phone in a chip; the UI handles that.

Context to use:
- Audience: working professionals (1–10 yrs), price sensitivity: ₹2–4 Lakh MBA programs.
- Tone: counselor-like, concise, pragmatic — avoid jargon.
- Funnel: keep user engaged with chips; only transition to lead capture when user shows clear interest.

Behavior examples (you must output JSON only):

Example 1 (user: "Fees?"):
{
  "reply": "Approx ₹2–4 Lakh. Want top options?",
  "chips": ["Top colleges", "Scholarship options", "Shortlist me"]
}

Example 2 (user: "Top online colleges"):
{
  "reply": "I’ll shortlist top online options. Okay?",
  "chips": ["1-year programs", "Fees range", "Shortlist me"]
}

Example 3 (user shows intent: "How do I apply?"):
{
  "reply": "Start with application form. Want help?",
  "chips": ["Apply now", "Eligibility check", "Shortlist me"]
}

If you cannot form a JSON (rare), output a short reply string as the "reply" and supply helpful default chips:
{
  "reply":"Sorry, try again",
  "chips":["Fees?","Eligibility?","Shortlist me"]
}

Important:
- Use INR notation (₹) when speaking about price.
- Keep chips short and actionable.
- Do not ask for personal contact details inside the chat — let the UI open the lead modal when user taps conversion chips.

`;

    // Build messages payload (keep last few messages)
    const payloadMessages = [
      { role: "system", content: systemPrompt },
      ...messages.slice(-8),
    ];

    // Call the OpenAI chat API
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: payloadMessages,
      temperature: 0.0, // deterministic for JSON output
      max_tokens: 160,
    });

    const raw = response?.choices?.[0]?.message?.content ?? "";
    const parsed = tryParseJsonFromText(raw);

    // If parsed JSON valid and has reply+chips, return structured object
    if (parsed && typeof parsed.reply === "string" && Array.isArray(parsed.chips)) {
      const reply = parsed.reply.trim();
      const chips = parsed.chips.map((c) => String(c).trim()).filter(Boolean).slice(0, 6);
      return res.json({ reply, chips });
    }

    // Fallback: if model output not valid JSON
    const fallbackReply = (typeof raw === "string" ? raw.split("\n")[0] : "Sorry, try again").trim();
    const defaultChips = ["Fees?","Eligibility?","Best MBA?","Placement?","Apply now"];
    return res.json({ reply: fallbackReply, chips: defaultChips });
  } catch (err) {
    console.error("Chat error:", err?.response?.data ?? err?.message ?? err);
    return res.status(500).json({ error: "chat_error", details: String(err) });
  }
});

// --- /lead endpoint (proxy to Apps Script) ---
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

// --- health check ---
app.get("/", (req, res) => res.send({ status: "ok", time: new Date().toISOString() }));

// --- start server ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Allowed origins:", ALLOWED_ORIGINS);
});
