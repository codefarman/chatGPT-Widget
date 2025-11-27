import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";


dotenv.config();

const app = express();
const corsOptions = {
    origin: 'http://127.0.0.1:3000/frontend/index.html', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
};

app.use(cors(corsOptions)); 
app.use(express.json());

// OpenAI Client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// POST API: /chat
app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages) {
      return res.status(400).json({ error: "messages is required" });
    }

    // Generate AI response
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are an empathetic MBA counselor for working professionals. 
Answer in 1 to 5 words and accurate, add a follow-up question at end.
If user shows interest (fees, eligibility, admission, apply, compare), 
the assistant begins lead capture: first ask name, then WhatsApp number.
`
        },
        ...messages.slice(-6)
      ],
      max_tokens: 30
    });

    const reply = response.choices[0].message.content;
    res.json({ reply });

  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

// Start Local Server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});



// // dev-server.js (optional local wrapper)
// import app from "./api/chat.js";
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Local server running http://localhost:${PORT}/api/chat`));
