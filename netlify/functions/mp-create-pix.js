// Creates a one-time PIX payment preference at MercadoPago
// for the specified email. Returns the checkout init_point URL.
// After payment, MP fires the webhook → mp-webhook updates Firestore.

const PRICE = 45.60;
const TITLE = 'Estoque Danny — Acesso 30 dias';

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email = (body.email || '').toLowerCase().trim();
  if (!email) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'email required' }) };
  }

  const origin = event.headers['origin'] || event.headers['referer'] || 'https://dannyestoque.netlify.app';
  const baseUrl = origin.replace(/\/$/, '');

  const preference = {
    items: [{
      title: TITLE,
      description: 'Acesso ao sistema de gestão de estoque por 30 dias',
      quantity: 1,
      currency_id: 'BRL',
      unit_price: PRICE
    }],
    payer: { email },
    external_reference: `pix:${email}`,
    payment_methods: {
      // PIX only — exclude card and boleto
      excluded_payment_types: [
        { id: 'credit_card' },
        { id: 'debit_card' },
        { id: 'ticket' },
        { id: 'atm' }
      ],
      installments: 1
    },
    back_urls: {
      success: `${baseUrl}/?payment=success`,
      pending: `${baseUrl}/?payment=pending`,
      failure: `${baseUrl}/?payment=failure`
    },
    auto_return: 'approved',
    statement_descriptor: 'ESTOQUE DANNY',
    metadata: { kind: 'pix-30d', email }
  };

  try {
    const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preference)
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('MP error', data);
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'MP API failed', detail: data }) };
    }
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        preferenceId: data.id,
        initPoint: data.init_point,
        sandboxInitPoint: data.sandbox_init_point
      })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};
