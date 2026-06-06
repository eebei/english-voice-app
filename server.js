require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Verify API key is set
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set in .env file');
  console.error('Please copy .env.example to .env and add your API key.');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Chat proxy ──────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages, max_tokens = 300, userName, character } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // ユーザーログ（Railway のログで確認可能）
    if (userName) {
      const now = new Date().toISOString();
      console.log(`[${now}] 👤 ${userName} | 🎭 ${character || '?'} | 💬 turn ${messages.filter(m=>m.role==='user').length}`);
    }

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens,
      system,
      messages,
    });

    res.json(response);
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅  English Voice Practice is running!');
  console.log(`  🌐  Open → http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
