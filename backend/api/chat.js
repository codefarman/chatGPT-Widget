// // api/chat.js
// import express from "express";
// import cors from "cors";
// import dotenv from "dotenv";
// import OpenAI from "openai";

// dotenv.config();

// const app = express();
// app.use(cors());
// app.use(express.json());

// // OpenAI client
// const client = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });

// // POST /api/chat
// // Note: this file is used as a serverless handler on Vercel — do NOT call app.listen()
// app.post("/", async (req, res) => {
//   try {
//     const { messages } = req.body;

//     if (!messages || !Array.isArray(messages)) {
//       return res.status(400).json({ error: "messages (array) is required in body" });
//     }

//     // System prompt: enforce very short replies (1-5 words) and lead-capture flow
//     const systemPrompt = `
// You are an empathetic MBA counselor for working professionals.
// Always answer in 1 to 5 words only (very short, precise). Do not explain.
// End with a tiny follow-up question (1-3 words).
// If user shows intent keywords: fees, eligibility, admission, apply, compare, placement, worth it
// -> begin lead capture by asking name, then WhatsApp number.
// Respond politely and concisely.
// `;

//     // Build messages array: system prompt + last up to 6 messages
//     const payloadMessages = [
//       { role: "system", content: systemPrompt },
//       ...messages.slice(-6)
//     ];

//     // Call OpenAI chat completion
//     const response = await client.chat.completions.create({
//       model: "gpt-4o-mini",
//       messages: payloadMessages,
//       max_tokens: 40,        // small allowance, keeps replies short
//       temperature: 0.2
//     });

//     const reply = response?.choices?.[0]?.message?.content ?? "";
//     return res.status(200).json({ reply: reply.trim() });

//   } catch (err) {
//     console.error("Chat error:", err);
//     return res.status(500).json({
//       error: "Internal server error",
//       details: err?.message ?? String(err)
//     });
//   }
// });

// // Export the express app instance — Vercel will wrap this as a serverless function
// export default app;
