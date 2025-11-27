// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import axios from "axios";

dotenv.config();


console.log(" MBA Counselor Backend Server Starting...");


// --- Config / env ---
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "https://chat-gpt-widget-three.vercel.app",
  "chat-gpt-widget-three.vercel.app"
];

let ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS;
if (process.env.ALLOWED_ORIGINS) {
  console.log(" Custom ALLOWED_ORIGINS env variable found");
  try {
    const parsed = JSON.parse(process.env.ALLOWED_ORIGINS);
    if (Array.isArray(parsed)) {
      ALLOWED_ORIGINS = parsed;
      console.log(" Custom origins parsed successfully:", parsed.length, "origins");
    }
  } catch (e) {
    console.warn(" ALLOWED_ORIGINS parse failed — using defaults.");
    console.error("Parse error:", e.message);
  }
} else {
  console.log(" Using default allowed origins");
}

// Normalize allowed origins into a set of hosts (host:port when present).
function normalizeAllowedHosts(list) {
  console.log("Normalizing allowed hosts from list:", list.length, "entries");
  const hosts = new Set();
  for (const entry of list) {
    if (!entry) continue;
    try {
      if (/^https?:\/\//i.test(entry)) {
        const u = new URL(entry);
        hosts.add(u.host); // hostname[:port]
        console.log(`  ✓ Added host from URL: ${u.host} (from ${entry})`);
      } else {
        // treat as hostname (maybe with port) or origin without scheme
        const normalized = entry.replace(/\/+$/, "");
        hosts.add(normalized);
        console.log(`  ✓ Added host directly: ${normalized}`);
      }
    } catch (e) {
      hosts.add(entry);
      console.log(` Added as-is (parse failed): ${entry}`);
    }
  }
  return hosts;
}

const ALLOWED_HOSTS = normalizeAllowedHosts(ALLOWED_ORIGINS);
console.log(" Allowed origins (raw):", ALLOWED_ORIGINS);
console.log("Allowed hosts (normalized):", Array.from(ALLOWED_HOSTS));

// --- OpenAI & Lead webhook config ---
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
if (!OPENAI_KEY) {
  console.error(" Warning: OPENAI_API_KEY is not set!");
} else {
  console.log(" OpenAI API key configured (length:", OPENAI_KEY.length, ")");
}

const LEAD_WEBHOOK_URL = process.env.LEAD_WEBHOOK_URL || "";
const LEAD_WEBHOOK_TOKEN = process.env.LEAD_WEBHOOK_TOKEN || "";

if (!LEAD_WEBHOOK_URL) {
  console.warn(" LEAD_WEBHOOK_URL is not set - lead submissions will fail");
} else {
  console.log(" Lead webhook URL configured:", LEAD_WEBHOOK_URL.substring(0, 50) + "...");
}

if (LEAD_WEBHOOK_TOKEN) {
  console.log(" Lead webhook token configured");
} else {
  console.log(" No lead webhook token set");
}

// --- Express app ---
const app = express();
app.use(express.json());
console.log("Express JSON middleware enabled");

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
    console.log(" CORS check - Origin:", origin || "(no origin header)");
    
    // allow non-browser requests (Postman / server-to-server)
    if (!origin) {
      console.log(" No origin header - allowing (non-browser request)");
      return callback(null, true);
    }

    const originHost = originToHost(origin);
    console.log("  Extracted host:", originHost);
    
    if (!originHost) {
      console.warn(" Unable to parse origin header:", origin);
      return callback(new Error("CORS origin invalid"));
    }

    if (ALLOWED_HOSTS.has(originHost)) {
      console.log("  Origin allowed (host match):", originHost);
      return callback(null, true);
    }
    
    // Also allow exact origin string if present in allowed origins raw
    if (ALLOWED_ORIGINS.includes(origin)) {
      console.log("  Origin allowed (exact match):", origin);
      return callback(null, true);
    }

    console.warn("   Blocked CORS origin:", origin, "=> host:", originHost);
    console.warn("   Allowed hosts:", Array.from(ALLOWED_HOSTS));
    return callback(new Error("CORS policy: Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));
console.log(" CORS middleware configured");

// Lightweight OPTIONS responder (avoid path-to-regexp errors)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    console.log("✓ OPTIONS request handled:", req.path);
    return res.sendStatus(200);
  }
  next();
});

// Error handler for CORS errors
app.use((err, req, res, next) => {
  if (err && /CORS/i.test(err.message || "")) {
    console.error(" CORS error caught:", err.message);
    return res.status(403).json({ error: "CORS error", message: err.message });
  }
  next(err);
});

// --- OpenAI client ---
const openai = new OpenAI({ apiKey: OPENAI_KEY });
console.log(" OpenAI client initialized");

// Robust JSON parser for model output
function tryParseJsonFromText(text) {
  console.log("Attempting to parse JSON from text (length:", text?.length || 0, ")");
  
  if (!text || typeof text !== "string") {
    console.warn(" Invalid input - not a string or empty");
    return null;
  }
  
  try {
    const parsed = JSON.parse(text);
    console.log("  Direct JSON parse successful");
    return parsed;
  } catch (e) {
    console.log("  Direct parse failed, trying regex extraction...");
    const m = text.match(/{[\s\S]*}/);
    if (m) {
      console.log("   Found JSON-like structure, attempting parse...");
      try {
        const parsed = JSON.parse(m[0]);
        console.log("  Regex-extracted JSON parse successful");
        return parsed;
      } catch (e2) {
        console.error("   Regex parse also failed:", e2.message);
        return null;
      }
    }
    console.error("   No JSON structure found in text");
    return null;
  }
}

// --- /chat endpoint ---
app.post("/chat", async (req, res) => {
  console.log("\n ======");
  console.log(" /chat endpoint called");
  console.log("=====");
  
  try {
    const { messages } = req.body;
    console.log("Request body received");
    console.log("  - Has messages?", !!messages);
    console.log("  - Is array?", Array.isArray(messages));
    console.log("  - Message count:", messages?.length || 0);
    
    if (!messages || !Array.isArray(messages)) {
      console.error(" Validation failed: messages not provided or not an array");
      return res.status(400).json({ error: "messages (array) required" });
    }

    console.log(" Conversation messages:");
    messages.forEach((msg, idx) => {
      console.log(`  ${idx + 1}. [${msg.role}]: ${msg.content?.substring(0, 50)}${msg.content?.length > 50 ? '...' : ''}`);
    });

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
    console.log("Prepared payload for OpenAI:");
    console.log("  - Total messages (with system):", payloadMessages.length);
    console.log("  - Using last", messages.slice(-8).length, "conversation messages");

    console.log("Calling OpenAI API...");
    const startTime = Date.now();

    // const maxTokens = wantsList ? 1200 : 350;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: payloadMessages,
      temperature: 0.0,
      max_tokens: 10000,
    });

    const elapsed = Date.now() - startTime;
    console.log(` OpenAI API response received (${elapsed}ms)`);

    const raw = response?.choices?.[0]?.message?.content ?? "";
    console.log("Raw response from OpenAI:");
    console.log("  Length:", raw.length);
    console.log("  Content:", raw.substring(0, 200) + (raw.length > 200 ? "..." : ""));
    
    const parsed = tryParseJsonFromText(raw);

    if (parsed && typeof parsed.reply === "string" && Array.isArray(parsed.chips)) {
      console.log("Successfully parsed structured response");
      const reply = parsed.reply.trim();
      const chips = parsed.chips.map((c) => String(c).trim()).filter(Boolean).slice(0, 6);
      
      console.log(" Sending response:");
      console.log("  - Reply:", reply.substring(0, 100) + (reply.length > 100 ? "..." : ""));
      console.log("  - Chips:", chips);
      
      return res.json({ reply, chips });
    }

    // fallback when model didn't return JSON
    console.warn("Failed to parse structured response, using fallback");
    const fallbackReply = (typeof raw === "string" ? raw.split("\n")[0] : "Sorry, try again").trim();
    const defaultChips = ["Apply now"];
    
    console.log(" Sending fallback response:");
    console.log("  - Reply:", fallbackReply);
    console.log("  - Chips:", defaultChips);
    
    return res.json({ reply: fallbackReply, chips: defaultChips });
    
  } catch (err) {
    console.error("Chat error occurred:");
    console.error("  Type:", err.constructor.name);
    console.error("  Message:", err?.message);
    console.error("  Response data:", err?.response?.data);
    console.error("  Stack:", err?.stack);
    return res.status(500).json({ error: "chat_error", details: String(err) });
  }
});

// --- /lead endpoint ---
app.post("/lead", async (req, res) => {
  console.log("\n=======");
  console.log(" /lead endpoint called");
  console.log("========");
  
  try {
    const { name, phone, firstMessage, conversation, timestamp } = req.body;
    
    console.log("Lead data received:");
    console.log("  - Name:", name || "(missing)");
    console.log("  - Phone:", phone || "(missing)");
    console.log("  - First message:", firstMessage || "(none)");
    console.log("  - Conversation length:", conversation?.length || 0);
    console.log("  - Timestamp:", timestamp || "(none)");
    
    if (!name || !phone) {
      console.error(" Validation failed: name or phone missing");
      return res.status(400).json({ error: "name & phone required" });
    }
    
    if (!LEAD_WEBHOOK_URL) {
      console.error(" Lead webhook not configured!");
      return res.status(500).json({ error: "lead_webhook_not_configured" });
    }

    const cleanPhone = String(phone).replace(/\D/g, "");
    console.log(" Cleaned phone number:", cleanPhone);
    
    const payload = { 
      name, 
      phone: cleanPhone, 
      firstMessage: firstMessage || "", 
      conversation: conversation || [], 
      timestamp: timestamp || new Date().toISOString() 
    };
    
    console.log("Prepared webhook payload:");
    console.log(JSON.stringify(payload, null, 2));
    
    const url = LEAD_WEBHOOK_TOKEN 
      ? `${LEAD_WEBHOOK_URL}${LEAD_WEBHOOK_URL.includes("?") ? "&" : "?"}token=${encodeURIComponent(LEAD_WEBHOOK_TOKEN)}` 
      : LEAD_WEBHOOK_URL;
    
    console.log("Sending to webhook URL:", url.substring(0, 50) + "...");
    const startTime = Date.now();

    const axiosResp = await axios.post(url, payload, { 
      headers: { "Content-Type": "application/json" }, 
      timeout: 15000 
    });
    
    const elapsed = Date.now() - startTime;
    console.log(` Webhook response received (${elapsed}ms)`);
    console.log("  Status:", axiosResp.status);
    console.log("  Data:", axiosResp.data);
    
    return res.status(200).json({ 
      success: true, 
      forwarded: true, 
      appsScriptResponse: axiosResp.data || null 
    });
    
  } catch (err) {
    console.error(" Lead forward error:");
    console.error("  Type:", err.constructor.name);
    console.error("  Message:", err?.message);
    console.error("  Response status:", err?.response?.status);
    console.error("  Response data:", err?.response?.data);
    console.error("  Stack:", err?.stack);
    return res.status(500).json({ 
      error: "lead_forward_error", 
      details: String(err) 
    });
  }
});

// health check
app.get("/", (req, res) => {
  console.log("Health check requested");
  const response = { 
    status: "ok", 
    time: new Date().toISOString(),
    config: {
      allowedOrigins: ALLOWED_ORIGINS.length,
      openaiConfigured: !!OPENAI_KEY,
      webhookConfigured: !!LEAD_WEBHOOK_URL
    }
  };
  console.log("  Response:", response);
  res.send(response);
});

// start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("\n==============");
  console.log(`Server listening on port ${PORT}`);
  console.log("===================");
  console.log(" Configuration Summary:");
  console.log("  - Port:", PORT);
  console.log("  - Allowed origins:", ALLOWED_ORIGINS.length);
  console.log("  - OpenAI configured:", !!OPENAI_KEY);
  console.log("  - Webhook configured:", !!LEAD_WEBHOOK_URL);
  console.log("  - Allowed hosts:", Array.from(ALLOWED_HOSTS).join(", "));
  console.log("=========\n");
  console.log(" Ready to accept requests!");
  console.log(" Health check available at: http://localhost:" + PORT + "/");
  console.log(" Chat endpoint: POST http://localhost:" + PORT + "/chat");
  console.log(" Lead endpoint: POST http://localhost:" + PORT + "/lead");
  console.log("");
});