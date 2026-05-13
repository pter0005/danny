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

  // Dump ALL env var keys Netlify exposes (no values, just key names)
  const allKeys = Object.keys(process.env).sort();
  // Categorize
  const netlifyBuiltin = allKeys.filter(k => k.startsWith('NETLIFY') || k.startsWith('AWS_') || k.startsWith('LAMBDA_') || k === 'NODE_ENV' || k === 'PATH' || k === 'HOME' || k === 'PWD' || k === 'LANG' || k === 'TZ');
  const userVars = allKeys.filter(k => !netlifyBuiltin.includes(k));

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expected: status,
      siteIdentity: {
        SITE_NAME: process.env.SITE_NAME || null,
        SITE_ID: process.env.SITE_ID || null,
        URL: process.env.URL || null,
        DEPLOY_URL: process.env.DEPLOY_URL || null,
        CONTEXT: process.env.CONTEXT || null,
        BRANCH: process.env.BRANCH || null
      },
      userEnvVarsFoundInFunctions: userVars,
      userVarCount: userVars.length,
      netlifyBuiltinCount: netlifyBuiltin.length,
      totalEnvVarsCount: allKeys.length,
      nodeVersion: process.version,
      time: new Date().toISOString()
    }, null, 2)
  };
};
