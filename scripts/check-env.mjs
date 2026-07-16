#!/usr/bin/env node
const required = ['DATABASE_URL', 'JWT_SECRET', 'MASTER_KEY'];
const cronOk = !!(process.env.CRON_SECRET?.trim() || process.env.CRONSECRET?.trim());
const optional = ['TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY', 'CORS_ORIGIN', 'ALLOW_VERCEL_PREVIEW', 'TZ', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGIN'];

let ok = true;
for (const key of required) {
  const val = process.env[key];
  if (!val) {
    console.log(`❌ ${key} — 未设置`);
    ok = false;
  } else {
    console.log(`✅ ${key}`);
  }
}
if (cronOk) {
  console.log('✅ CRON_SECRET / CRONSECRET');
} else {
  console.log('❌ CRON_SECRET / CRONSECRET — 未设置');
  ok = false;
}
for (const key of optional) {
  console.log(process.env[key] ? `✅ ${key} (optional)` : `⚪ ${key} (optional, 未设置)`);
}
if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.log('⚠️  JWT_SECRET 建议至少 32 字符');
}
process.exit(ok ? 0 : 1);
