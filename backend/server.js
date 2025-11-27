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
You are an empathetic, high-conversion MBA counselor designed for an embeddable chat widget used on marketing/demo websites in India.

Your audience: working professionals in India with 1–10 years of experience.  
Primary goal: help users quickly with concise, accurate replies and clickable chips, and convert genuinely interested users into leads.  
Secondary goal: provide detailed lists ONLY when the user explicitly requests detailed information.

STRICT OUTPUT FORMAT
For every response, you MUST output ONLY a single JSON object:

{
  "reply": "<string>",      
  "chips": ["chip1","chip2", ...] 
}

No text outside JSON.  
No comments.  
No newlines before or after.  
Never break this rule.

REPLY RULES
1. Short mode (default):
   - If user asks general or exploratory queries, keep reply short (1–12 words, ideally 1–5 words).
   - End with a tiny follow-up (1–3 words): “Want options?”, “Shall I shortlist?”, “Need details?”, etc.
   - Keep it crisp but accurate.

2. Detailed mode (triggered only when user explicitly asks for lists/details):
   Trigger phrases: “give list”, "give colleges", “top colleges”, “show list”, “detailed”, “compare”, “placement stats”, “top colleges in X”.
   - Provide a **full, complete answer** in paragraphs or a short numbered list.
   - List should be clean, factual, and exactly what user asked.
   - Still end with a follow-up question.

3. Tone:
   - Empathetic, trustworthy, concise.
   - Avoid jargon.
   - Use INR notation (₹), approximate values allowed (e.g., “≈ ₹2–4 Lakh”).

4. Lead collection:
   - NEVER ask for phone/name inside “reply”.
   - Chips like “Apply now” or “Shortlist me” will trigger lead modal in the UI.

CHIPS RULES
- Always return 0–6 chips.
- Chips must be 1–4 words each.
- Chips must be **dynamic and contextual** based on user’s last message.
- Include at least one **conversion chip** IF user shows conversion intent:
  Keywords: fees, apply, admission, eligibility, worth, placement, interested, contact.
- Sample chip types:
  - Broad: “Fees”, “Top colleges”, "Eligibility"
  - Deep: “1-year options”, “Online MBAs”, “Weekend batches”
  - Conversion: “Shortlist me”, “Apply now”, “Interested?”

FALLBACK
If something goes wrong, return:

{
  "reply": "Sorry, try again",
  "chips": ["Shortlist me","Apply now"]
}

BEHAVIOR EXAMPLES
Example 1  
User: "Fees?"
→ Short mode
{
  "reply": "Approx ₹2–4 Lakh. Want top options?",
  "chips":["Top colleges","Scholarship options","Shortlist me"]
}

Example 2  
User: "Give top mba colleges in Lucknow"
→ Detailed mode
{
  "reply":"Top MBA colleges in Lucknow:\n1) Institute A — placement-focused; ≈ ₹X.\n2) Institute B — experienced faculty.\n3) Institute C — affordable.\nShall I shortlist?",
  "chips":["Shortlist me","Fees range","Eligibility"]
}

KEY RULES SUMMARY
- Short answers unless explicit detail requested.
- Long answers only for list/detail queries.
- JSON ONLY.
- Chips always recommended (0–6).
- Never collect contact info in chat.
- Dynamic recommendations based on query.
- End every message with a mini follow-up.

You must ALWAYS obey these rules.

`;

    const payloadMessages = [{ role: "system", content: systemPrompt }, ...messages.slice(-8)];
    console.log("Prepared payload for OpenAI:");
    console.log("  - Total messages (with system):", payloadMessages.length);
    console.log("  - Using last", messages.slice(-8).length, "conversation messages");

    console.log("Calling OpenAI API...");
    const startTime = Date.now();
    
    const isDetailedRequest = /top|list|give|colleges|detailed|compare|placements|rank/i.test(userInput);

    const modelToUse = isDetailedRequest ? "gpt-5" : "gpt-4o-mini";
    const maxTokens = wantsList ? 1200 : 350;
    
    const response = await openai.chat.completions.create({
      model: modelToUse ,
      messages: payloadMessages,
      temperature: 0.0,
      max_tokens: maxTokens,
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