// Debug endpoint — shows env vars status + recent Firestore events + MP payments.
// REMOVE AFTER DIAGNOSING.

const admin = require('firebase-admin');

if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

async function recentFirestore() {
  if (!admin.apps.length) return { error: 'firebase not initialized' };
  const db = admin.firestore();
  try {
    const [eventsSnap, subsSnap, paymentsSnap] = await Promise.all([
      db.collection('paymentEvents').orderBy('receivedAt', 'desc').limit(8).get(),
      db.collection('subscriptions').get(),
      db.collection('paymentHistory').orderBy('paidAt', 'desc').limit(8).get()
    ]);
    return {
      paymentEvents: eventsSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          type: x.type,
          action: x.action,
          receivedAt: x.receivedAt?.toDate?.()?.toISOString() || null,
          sigStatus: x.meta?.sigStatus,
          error: x.meta?.error || null,
          rawDataId: x.raw?.data?.id
        };
      }),
      subscriptions: subsSnap.docs.map(d => ({ email: d.id, ...d.data(), activeUntil: d.data().activeUntil?.toDate?.()?.toISOString() || null, lastPaymentAt: d.data().lastPaymentAt?.toDate?.()?.toISOString() || null })),
      paymentHistory: paymentsSnap.docs.map(d => ({ id: d.id, ...d.data(), paidAt: d.data().paidAt?.toDate?.()?.toISOString() || null }))
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function recentMpPayments() {
  const t = process.env.MP_ACCESS_TOKEN;
  if (!t) return { error: 'no token' };
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await fetch(`https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${since}&end_date=NOW&limit=8`, {
      headers: { Authorization: `Bearer ${t}` }
    });
    const data = await res.json();
    return (data.results || []).map(p => ({
      id: p.id,
      status: p.status,
      status_detail: p.status_detail,
      transaction_amount: p.transaction_amount,
      payment_method_id: p.payment_method_id,
      payer_email: p.payer?.email,
      external_reference: p.external_reference,
      date_created: p.date_created,
      date_approved: p.date_approved
    }));
  } catch (e) {
    return { error: e.message };
  }
}

exports.handler = async () => {
  const expected = [
    'MP_ACCESS_TOKEN',
    'MP_WEBHOOK_SECRET',
    'FIREBASE_SERVICE_ACCOUNT',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID'
  ];

  const status = {};
  expected.forEach((k) => {
    const v = process.env[k];
    if (v == null) status[k] = '❌ MISSING';
    else if (v === '') status[k] = '⚠️ EMPTY STRING';
    else status[k] = `✅ set (${v.length} chars, starts: "${v.slice(0, 16).replace(/\n/g, '\\n')}...")`;
  });

  // Dump ALL env var keys Netlify exposes (no values, just key names)
  const allKeys = Object.keys(process.env).sort();
  // Categorize
  const netlifyBuiltin = allKeys.filter(k => k.startsWith('NETLIFY') || k.startsWith('AWS_') || k.startsWith('LAMBDA_') || k === 'NODE_ENV' || k === 'PATH' || k === 'HOME' || k === 'PWD' || k === 'LANG' || k === 'TZ');
  const userVars = allKeys.filter(k => !netlifyBuiltin.includes(k));

  const [firestore, mpPayments] = await Promise.all([recentFirestore(), recentMpPayments()]);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expected: status,
      siteIdentity: {
        SITE_NAME: process.env.SITE_NAME || null,
        URL: process.env.URL || null
      },
      firestore,
      recentMpPayments: mpPayments,
      time: new Date().toISOString()
    }, null, 2)
  };
};
