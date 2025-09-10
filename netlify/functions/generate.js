// /netlify/functions/generate.js
// Uses Node 18+ native fetch (no node-fetch needed)

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: cors,
        body: JSON.stringify({ error: 'OPENAI_API_KEY is not set in Netlify.' })
      };
    }

    const body = JSON.parse(event.body || '{}');
    const {
      messages,
      temperature = 0.4,
      max_tokens = 1200,
      model = 'gpt-4o-mini'
    } = body;

    if (!Array.isArray(messages)) {
      return {
        statusCode: 400,
        headers: cors,
        body: JSON.stringify({ error: 'messages[] required' })
      };
    }

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: cors,
        body: JSON.stringify({ error: data?.error?.message || 'OpenAI error' })
      };
    }

    const content = data?.choices?.[0]?.message?.content ?? '';
    return { statusCode: 200, headers: cors, body: JSON.stringify({ content }) };

  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: String(err?.message || err) })
    };
  }
};

