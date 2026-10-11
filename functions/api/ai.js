const hits = new Map();
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequestGet({ env }) {
  return J({ ok: !!env.GROQ_API_KEY });
}

export async function onRequestPost({ request, env }) {
  if (!env.GROQ_API_KEY) return J({ error: 'not_configured' }, 503);

  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return J({ error: 'forbidden' }, 403);

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
  const model = vision
    ? (env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct')
    : (env.TEXT_MODEL || 'llama-3.3-70b-versatile');
  const messages = body.messages.map(m => ({ role: m.role === 'system' ? 'system' : 'user', content: m.content }));

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.GROQ_API_KEY },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 3000, response_format: { type: 'json_object' } })
    });
    if (!r.ok) return J({ error: 'upstream', status: r.status }, r.status === 429 ? 429 : 502);
    const j = await r.json();
    return J({ content: j.choices?.[0]?.message?.content || '' });
  } catch { return J({ error: 'upstream' }, 502); }
                          }
