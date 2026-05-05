// Returns subscription status for an email.
// Used by the frontend to decide whether to allow access or show paywall.
// Defense in depth: frontend already reads Firestore, but this endpoint
// can also resync from MP API on demand (e.g. after user pays, force refresh).

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!svcJson) throw new Error('FIREBASE_SERVICE_ACCOUNT env var missing');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(svcJson))
  });
}
const db = admin.firestore();
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

async function mpFetch(path) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` }
  });
  if (!res.ok) throw new Error(`MP ${path} → ${res.status}`);
  return res.json();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

function isActive(sub) {
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  const until = sub.activeUntil?.toDate ? sub.activeUntil.toDate() : (sub.activeUntil ? new Date(sub.activeUntil) : null);
  if (!until) return false;
  return until.getTime() > Date.now();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders() };
  }

  const params = event.queryStringParameters || {};
  const email = (params.email || '').toLowerCase().trim();
  const refresh = params.refresh === '1';

  if (!email) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'email required' }) };
  }

  try {
    const ref = db.collection('subscriptions').doc(email);
    let snap = await ref.get();
    let data = snap.exists ? snap.data() : null;

    // If refresh=1 and we have a preapprovalId, force resync from MP
    if (refresh && data?.mpPreapprovalId) {
      try {
        const p = await mpFetch(`/preapproval/${data.mpPreapprovalId}`);
        const status = p.status === 'authorized' ? 'active' : p.status;
        const update = {
          status,
          nextPaymentAt: p.next_payment_date ? admin.firestore.Timestamp.fromDate(new Date(p.next_payment_date)) : null,
          activeUntil: p.next_payment_date ? admin.firestore.Timestamp.fromDate(new Date(p.next_payment_date)) : null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await ref.set(update, { merge: true });
        snap = await ref.get();
        data = snap.data();
      } catch (e) {
        console.error('refresh error', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        email,
        active: isActive(data),
        subscription: data || null
      })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message })
    };
  }
};
