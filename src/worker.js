const hits = new Map();
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Gemini is used if GEMINI_API_KEY exists, otherwise Groq.
function provider(env, vision) {
  if (env.GEMINI_API_KEY) {
    return { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || 'gemini-flash-latest' };
  }
  if (env.GROQ_API_KEY) {
    return { url: 'https://api.groq.com/openai/v1/chat/completions', key: env.GROQ_API_KEY,
      model: vision ? (env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct') : (env.TEXT_MODEL || 'openai/gpt-oss-120b') };
  }
  return null;
}

async function ai(request, env) {
  const url = new URL(request.url), origin = request.headers.get('Origin');
  if (origin) {
    let oh = '';
    try { oh = new URL(origin).host; } catch {}
    const host = request.headers.get('Host') || url.host;
    if (oh !== host && oh !== url.host) return J({ error: 'forbidden', detail: 'origin ' + oh + ' vs ' + host }, 403);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown', now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= 20) return J({ error: 'rate_limited' }, 429);
  recent.push(now); hits.set(ip, recent);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2000000) return J({ error: 'too_large' }, 413);
    body = JSON.parse(raw);
  } catch { return J({ error: 'bad_request' }, 400); }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 4) return J({ error: 'bad_request' }, 400);
  const vision = body.task === 'vision';
  const p = provider(env, vision);
  if (!p) return J({ error: 'not_configured' }, 503);
  const messages = body.messages.map(m => ({ role: m.role === 'system' ? 'system' : 'user', content: m.content }));
  try {
    const r = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify({ model: p.model, messages, temperature: 0.7, max_tokens: 6000, response_format: { type: 'json_object' } })
    });
    if (!r.ok) {
      const t = await r.text();
      return J({ error: 'upstream', status: r.status, detail: t.slice(0, 200) }, r.status === 429 ? 429 : 502);
    }
    const j = await r.json();
    return J({ content: j.choices?.[0]?.message?.content || '' });
  } catch (e) { return J({ error: 'upstream', detail: String(e).slice(0, 100) }, 502); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') {
      if (request.method === 'GET') return J({ ok: !!(env.GEMINI_API_KEY || env.GROQ_API_KEY) });
      if (request.method === 'POST') return ai(request, env);
      return J({ error: 'method_not_allowed' }, 405);
    }
    return env.ASSETS.fetch(request);
  }
};
