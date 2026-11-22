import { backupKey } from './backup-lib.mjs';
// كل يوم 01:00 UTC (04:00 بتوقيت الرياض): تستدعي الدالة الخلفية لأن الدوال المجدولة محدودة بـ30 ثانية.
export const config = { schedule: '0 1 * * *' };
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL; if (!base) return;
  await fetch(base + '/.netlify/functions/backup-background', { method: 'POST', headers: { 'x-backup-key': backupKey(process.env) } });
};
