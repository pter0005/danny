// Debug endpoint — shows which env vars are set (masked) without leaking values.
// REMOVE AFTER DIAGNOSING.

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

  // Also list what env keys ARE present (mask values)
  const otherKeys = Object.keys(process.env)
    .filter((k) => !expected.includes(k) && (k.startsWith('FIREBASE') || k.startsWith('MP_') || k.startsWith('TELEGRAM')))
    .reduce((o, k) => { o[k] = `(${(process.env[k] || '').length} chars)`; return o; }, {});

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expected: status,
      otherRelatedKeysFound: otherKeys,
      nodeVersion: process.version,
      time: new Date().toISOString()
    }, null, 2)
  };
};
