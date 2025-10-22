// Simple AI proxy server to keep API keys server-side
// Requirements: Node.js 18+ (for global fetch)
// Usage:
//  1) Set environment variables in .env (see .env.example)
//  2) npm install
//  3) npm start

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: in development allow all; in production restrict by ORIGIN env or same-origin when serving static
const allowedOrigin = process.env.ORIGIN || undefined;
app.use(cors({ origin: allowedOrigin ? [allowedOrigin] : true }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Serve static frontend from project root (one origin)
const clientRoot = path.join(__dirname, '..');
app.use(express.static(clientRoot));

// Fallback to index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(clientRoot, 'index.html'));
});

app.post('/api/chat', async (req, res) => {
    try {
        const { provider = 'openai', model = 'gpt-4o-mini', system = '', prompt = '' } = req.body || {};
        if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 2) {
            return res.status(400).json({ error: 'Invalid prompt' });
        }

        let endpoint, apiKey, headersExtra = {};
        if (provider === 'openrouter') {
            endpoint = 'https://openrouter.ai/api/v1/chat/completions';
            apiKey = process.env.OPENROUTER_API_KEY;
            headersExtra = { 'HTTP-Referer': 'http://localhost', 'X-Title': 'ATS-Analyzer' };
        } else {
            endpoint = 'https://api.openai.com/v1/chat/completions';
            apiKey = process.env.OPENAI_API_KEY;
        }

        if (!apiKey) {
            return res.status(500).json({ error: `Missing API key for provider ${provider}. Set it in server/.env` });
        }

        const body = {
            model,
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                { role: 'user', content: prompt }
            ],
            temperature: 0.25
        };

        const r = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                ...headersExtra
            },
            body: JSON.stringify(body)
        });

        if (!r.ok) {
            let msg = `${r.status} ${r.statusText}`;
            try { const j = await r.json(); msg = j.error?.message || msg; } catch {}
            return res.status(r.status).json({ error: msg });
        }

        const data = await r.json();
        const text = data.choices?.[0]?.message?.content?.trim() || '';
        return res.json({ text });
    } catch (err) {
        console.error('Proxy error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
