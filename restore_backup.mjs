// استعادة نسخة احتياطية (للمالك فقط، من جهازك). الاستخدام:
//   npm install
//   NETLIFY_SITE_ID=... NETLIFY_TOKEN=... node restore_backup.mjs imt-backup-....json.gz [--yes]
// يكتب سجلات النسخة فوق السجلات الحالية بنفس المفاتيح، ولا يحذف سجلات أحدث غير موجودة في النسخة.
import fs from 'node:fs'; import zlib from 'node:zlib'; import { getStore } from '@netlify/blobs';
const [file, yes] = process.argv.slice(2);
if (!file || !process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) { console.log('الاستخدام: NETLIFY_SITE_ID=.. NETLIFY_TOKEN=.. node restore_backup.mjs <ملف.json.gz> [--yes]'); process.exit(1) }
const dump = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
if (dump.format !== 'imt-backup-1') { console.log('ملف غير معروف'); process.exit(1) }
console.log(`النسخة بتاريخ ${dump.at} وفيها ${dump.count} سجل.`);
if (yes !== '--yes') { console.log('هذا تشغيل تجريبي. أضف --yes للكتابة الفعلية.'); process.exit(0) }
const store = getStore({ name: 'imt-db', siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_TOKEN, consistency: 'strong' });
const cols = new Set(); let n = 0;
for (const [k, v] of Object.entries(dump.data)) { await store.set(k, v); cols.add(k.split('/')[1]); if (++n % 100 === 0) console.log(n) }
for (const c of cols) await store.set(`v/${c}`, String(Date.now()) + 'r');
console.log('تمت الاستعادة:', n, 'سجل');
