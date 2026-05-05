// MercadoPago webhook receiver
// Receives notifications, validates HMAC signature, fetches details from MP API,
// updates Firestore subscriptions collection.

const crypto = require('crypto');
const admin = require('firebase-admin');

// ───── Firebase Admin init (singleton) ─────
if (!admin.apps.length) {
  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!svcJson) throw new Error('FIREBASE_SERVICE_ACCOUNT env var missing');
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(svcJson))
  });
}
const db = admin.firestore();

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_SECRET = process.env.MP_WEBHOOK_SECRET;

// ───── Helpers ─────
function validateSignature(headers, dataId) {
  if (!MP_SECRET) return { ok: true, reason: 'secret-not-configured' }; // permite enquanto não setado

  const sigHeader = headers['x-signature'] || headers['X-Signature'];
  const requestId = headers['x-request-id'] || headers['X-Request-Id'];
  if (!sigHeader || !requestId) return { ok: false, reason: 'missing-headers' };

  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.trim().split('='))
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return { ok: false, reason: 'malformed-signature' };

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto
    .createHmac('sha256', MP_SECRET)
    .update(manifest)
    .digest('hex');

  const ok = crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(v1)
  );
  return { ok, reason: ok ? 'valid' : 'mismatch' };
}

async function mpFetch(path) {
  const res = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${MP_TOKEN}` }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`MP ${path} → ${res.status}: ${txt}`);
  }
  return res.json();
}

// ───── Telegram notifications ─────
async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('Telegram not configured, skipping notify');
    return { skipped: 'no-config' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    });
    if (!res.ok) console.error('Telegram error', await res.text());
    return { ok: res.ok };
  } catch (e) {
    console.error('Telegram fetch failed', e.message);
    return { error: e.message };
  }
}

function fmtBRL(v) {
  if (v == null) return '—';
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

function fmtDate(d) {
  if (!d) return '—';
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function emailToDocId(email) {
  return email.toLowerCase().trim();
}

async function logEvent(type, action, raw, meta = {}) {
  await db.collection('paymentEvents').add({
    type,
    action: action || null,
    raw,
    meta,
    receivedAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// ───── Event handlers ─────
async function handlePreapproval(preapprovalId) {
  const p = await mpFetch(`/preapproval/${preapprovalId}`);
  // Status from MP: 'pending' | 'authorized' | 'paused' | 'cancelled'
  const status = p.status === 'authorized' ? 'active' : p.status;
  const email = (p.payer_email || '').toLowerCase().trim();
  if (!email) throw new Error('preapproval has no payer_email');

  const update = {
    email,
    status,
    mpPreapprovalId: preapprovalId,
    mpPlanId: p.preapproval_plan_id || null,
    amount: p.auto_recurring?.transaction_amount ?? null,
    currency: p.auto_recurring?.currency_id ?? 'BRL',
    frequency: p.auto_recurring?.frequency ?? null,
    frequencyType: p.auto_recurring?.frequency_type ?? null,
    nextPaymentAt: p.next_payment_date
      ? admin.firestore.Timestamp.fromDate(new Date(p.next_payment_date))
      : null,
    activeUntil: p.next_payment_date
      ? admin.firestore.Timestamp.fromDate(new Date(p.next_payment_date))
      : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection('subscriptions').doc(emailToDocId(email)).set(update, { merge: true });

  // Notify Telegram on important state changes
  if (status === 'active') {
    await notifyTelegram(
      `🆕 *Nova assinatura ativa*\n` +
      `👤 ${email}\n` +
      `💰 ${fmtBRL(update.amount)}/mês\n` +
      `📅 Próxima cobrança: ${fmtDate(p.next_payment_date)}`
    );
  } else if (status === 'cancelled') {
    await notifyTelegram(`🚫 *Assinatura cancelada*\n👤 ${email}`);
  } else if (status === 'paused') {
    await notifyTelegram(`⏸️ *Assinatura pausada*\n👤 ${email}`);
  }

  return { email, status, nextPaymentAt: p.next_payment_date };
}

async function handleAuthorizedPayment(paymentId) {
  // Recurring payment generated by a preapproval
  const ap = await mpFetch(`/authorized_payments/${paymentId}`);
  const preapprovalId = ap.preapproval_id;
  if (!preapprovalId) return { skipped: 'no preapproval_id' };

  const p = await mpFetch(`/preapproval/${preapprovalId}`);
  const email = (p.payer_email || '').toLowerCase().trim();
  if (!email) return { skipped: 'no email' };

  const paid = ap.status === 'processed' && ap.payment?.status === 'approved';

  const update = {
    email,
    mpPreapprovalId: preapprovalId,
    nextPaymentAt: p.next_payment_date
      ? admin.firestore.Timestamp.fromDate(new Date(p.next_payment_date))
      : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (paid) {
    update.status = 'active';
    update.activeUntil = p.next_payment_date
      ? admin.firestore.Timestamp.fromDate(new Date(p.next_payment_date))
      : null;
    update.lastPaymentAt = admin.firestore.FieldValue.serverTimestamp();
    update.lastPaymentAmount = ap.transaction_amount || ap.payment?.transaction_amount || null;
    update.lastPaymentId = ap.payment?.id || paymentId;

    await db.collection('paymentHistory').add({
      email,
      paymentId: ap.payment?.id || paymentId,
      preapprovalId,
      amount: ap.transaction_amount || null,
      status: 'approved',
      method: ap.payment_method_id || null,
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } else if (ap.status === 'rejected' || ap.payment?.status === 'rejected') {
    update.status = 'overdue';
    update.lastFailedAt = admin.firestore.FieldValue.serverTimestamp();
    update.lastFailReason = ap.payment?.status_detail || ap.status;
  }

  await db.collection('subscriptions').doc(emailToDocId(email)).set(update, { merge: true });

  // Notify Telegram
  if (paid) {
    await notifyTelegram(
      `💰 *Pagamento recebido (cartão)*\n` +
      `👤 ${email}\n` +
      `💵 ${fmtBRL(update.lastPaymentAmount)}\n` +
      `📅 Próxima cobrança: ${fmtDate(p.next_payment_date)}`
    );
  } else if (update.status === 'overdue') {
    await notifyTelegram(
      `⚠️ *Pagamento NÃO autorizado*\n` +
      `👤 ${email}\n` +
      `❌ Motivo: ${update.lastFailReason || 'desconhecido'}\n` +
      `Acesso ao app pode ser interrompido — verifique no MP.`
    );
  }

  return { email, paid, status: update.status };
}

async function handlePayment(paymentId) {
  const p = await mpFetch(`/v1/payments/${paymentId}`);

  // Detect one-time PIX payment via external_reference (format: "pix:email@x.com")
  const ref = p.external_reference || '';
  if (ref.startsWith('pix:') && p.status === 'approved') {
    const email = ref.slice(4).toLowerCase().trim();
    if (!email) return { skipped: 'pix-no-email' };

    // Grant +30 days from the latest of (now, current activeUntil)
    const docRef = db.collection('subscriptions').doc(emailToDocId(email));
    const snap = await docRef.get();
    const current = snap.exists ? snap.data() : null;
    const currentUntil = current?.activeUntil?.toDate
      ? current.activeUntil.toDate()
      : (current?.activeUntil ? new Date(current.activeUntil) : null);
    const start = currentUntil && currentUntil.getTime() > Date.now() ? currentUntil : new Date();
    const newUntil = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);

    await docRef.set({
      email,
      status: 'active',
      paymentKind: 'pix',
      activeUntil: admin.firestore.Timestamp.fromDate(newUntil),
      lastPaymentAt: admin.firestore.FieldValue.serverTimestamp(),
      lastPaymentAmount: p.transaction_amount || null,
      lastPaymentId: paymentId,
      lastPaymentMethod: 'pix',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('paymentHistory').add({
      email,
      paymentId,
      amount: p.transaction_amount || null,
      status: 'approved',
      method: 'pix',
      kind: 'pix-30d',
      grantedUntil: admin.firestore.Timestamp.fromDate(newUntil),
      paidAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await notifyTelegram(
      `⚡ *PIX recebido!*\n` +
      `👤 ${email}\n` +
      `💵 ${fmtBRL(p.transaction_amount)}\n` +
      `🔓 Acesso liberado até ${fmtDate(newUntil)}`
    );

    return { kind: 'pix', email, grantedUntil: newUntil.toISOString() };
  }

  // Standalone non-subscription payments — log and skip
  if (!p.metadata?.preapproval_id) {
    return { skipped: 'standalone-payment', status: p.status };
  }
  return { logged: true, status: p.status };
}

// ───── Handler ─────
exports.handler = async (event) => {
  // Health check via GET
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, service: 'mp-webhook', time: new Date().toISOString() })
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const type = body.type || body.action || 'unknown';
  const action = body.action || null;
  const dataId = body.data?.id || body.id || '';

  // Validate signature
  const sig = validateSignature(event.headers, dataId);
  if (!sig.ok) {
    await logEvent(type, action, body, { sigError: sig.reason });
    return { statusCode: 401, body: `Invalid signature: ${sig.reason}` };
  }

  // Always log event
  await logEvent(type, action, body, { sigStatus: sig.reason });

  try {
    let result = null;
    if (type === 'subscription_preapproval' || type === 'preapproval') {
      result = await handlePreapproval(dataId);
    } else if (type === 'subscription_authorized_payment' || type === 'authorized_payment') {
      result = await handleAuthorizedPayment(dataId);
    } else if (type === 'payment') {
      result = await handlePayment(dataId);
    } else {
      result = { skipped: `unknown-type-${type}` };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, type, result })
    };
  } catch (err) {
    console.error('webhook error', err);
    await logEvent(type, action, body, { error: err.message });
    // Return 200 anyway so MP doesn't retry forever; we already logged
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, error: err.message })
    };
  }
};
