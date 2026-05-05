// Creates a PIX payment via MercadoPago API and returns QR code + copy-paste code.
// User pays in-app (no redirect). Webhook fires when paid → updates Firestore.

const PRICE = 45.60;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

// Compute next "dia 12" of the current or next month (vencimento)
function nextDueDate12() {
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), 12, 23, 59, 59);
  if (due.getTime() < now.getTime()) {
    due.setMonth(due.getMonth() + 1);
  }
  // MP requires the date_of_expiration to be in ISO format with timezone
  return due;
}

function isoWithTZ(d) {
  // MP requires ISO with offset: "2026-05-12T23:59:59.000-03:00"
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
  const om = pad(Math.abs(offsetMin) % 60);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    + '.000' + sign + oh + ':' + om;
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

  const due = nextDueDate12();
  const idempotencyKey = `pix-${email}-${Date.now()}`;

  const payload = {
    transaction_amount: PRICE,
    description: 'Estoque Danny - Mensalidade',
    payment_method_id: 'pix',
    external_reference: `pix:${email}`,
    payer: { email },
    date_of_expiration: isoWithTZ(due),
    notification_url: `https://dannyestoque.netlify.app/api/mp-webhook`,
    metadata: { kind: 'pix-30d', email }
  };

  try {
    const res = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('MP error', data);
      return { statusCode: 502, headers: corsHeaders(), body: JSON.stringify({ error: 'MP API failed', detail: data }) };
    }
    const tx = data.point_of_interaction?.transaction_data || {};
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        paymentId: data.id,
        qrCode: tx.qr_code || null,
        qrCodeBase64: tx.qr_code_base64 || null,
        ticketUrl: tx.ticket_url || null,
        expiresAt: data.date_of_expiration,
        amount: PRICE
      })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};
