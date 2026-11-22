import { getStore } from '@netlify/blobs';
import { runBackup, backupKey } from './backup-lib.mjs';
// دالة خلفية (حتى 15 دقيقة). تُستدعى من الجدولة أو من زر المالك، ولا تُقبل بدون المفتاح.
export default async (req) => {
  if (req.headers.get('x-backup-key') !== backupKey(process.env)) return new Response('forbidden', { status: 403 });
  await runBackup(getStore({ name: 'imt-db', consistency: 'strong' }), process.env);
  return new Response('done');
};
