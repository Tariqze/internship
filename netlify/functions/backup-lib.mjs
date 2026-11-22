// نسخ احتياطي دوري إلى OneDrive عبر Microsoft Graph (صلاحية التطبيق، بدون تسجيل دخول مستخدم).
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const backupKey = (env) => crypto.createHmac('sha256', env.SESSION_SECRET || ('imt:' + (env.OWNER_PASSWORD || 'change-me'))).update('backup-trigger').digest('base64url');
export const backupConfigured = (env) => !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && (env.MS_DRIVE_USER || env.MS_DRIVE_ID));

async function dumpAll(store) {
  const { blobs } = await store.list({ prefix: 'd/' }); const data = {};
  for (let i = 0; i < blobs.length; i += 25) {
    await Promise.all(blobs.slice(i, i + 25).map(async (b) => { const t = await store.get(b.key); if (t != null) data[b.key] = t }));
  }
  return { format: 'imt-backup-1', at: new Date().toISOString(), count: Object.keys(data).length, data };
}

export async function runBackup(store, env, f = fetch) {
  const GRAPH = env.MS_GRAPH_BASE || 'https://graph.microsoft.com', LOGIN = env.MS_LOGIN_BASE || 'https://login.microsoftonline.com';
  const KEEP = Math.max(3, parseInt(env.BACKUP_KEEP || '30', 10) || 30), FOLDER = (env.MS_FOLDER || 'IMT-Backups').replace(/^\/+|\/+$/g, '');
  const st = { at: new Date().toISOString(), ok: false };
  try {
    if (!backupConfigured(env)) throw new Error('إعدادات OneDrive غير مكتملة (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MS_DRIVE_USER)');
    const dump = await dumpAll(store); st.docs = dump.count;
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify(dump), 'utf8')); st.bytes = buf.length;
    const name = `imt-backup-${dump.at.replace(/[:.]/g, '-')}.json.gz`; st.name = name;
    const tr = await f(`${LOGIN}/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }) });
    const tj = await tr.json().catch(() => ({})); if (!tr.ok || !tj.access_token) throw new Error('فشل الحصول على رمز Microsoft: ' + (tj.error_description || tj.error || tr.status).toString().slice(0, 160));
    const H = { authorization: 'Bearer ' + tj.access_token };
    const drive = env.MS_DRIVE_ID ? `${GRAPH}/v1.0/drives/${encodeURIComponent(env.MS_DRIVE_ID)}` : `${GRAPH}/v1.0/users/${encodeURIComponent(env.MS_DRIVE_USER)}/drive`;
    const path = FOLDER.split('/').map(encodeURIComponent).join('/');
    const sr = await f(`${drive}/root:/${path}/${encodeURIComponent(name)}:/createUploadSession`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) });
    const sj = await sr.json().catch(() => ({})); if (!sr.ok || !sj.uploadUrl) throw new Error('فشل بدء الرفع إلى OneDrive: ' + ((sj.error && sj.error.message) || sr.status).toString().slice(0, 160));
    const CH = 320 * 1024 * 10;
    for (let o = 0; o < buf.length; o += CH) {
      const part = buf.subarray(o, Math.min(o + CH, buf.length));
      const ur = await f(sj.uploadUrl, { method: 'PUT', headers: { 'content-length': String(part.length), 'content-range': `bytes ${o}-${o + part.length - 1}/${buf.length}` }, body: part });
      if (!ur.ok && ur.status !== 202) throw new Error('فشل رفع جزء من النسخة: ' + ur.status);
    }
    const lr = await f(`${drive}/root:/${path}:/children?$select=id,name&$top=500`, { headers: H });
    if (lr.ok) {
      const lj = await lr.json(), old = (lj.value || []).filter((x) => /^imt-backup-.*\.json\.gz$/.test(x.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(KEEP);
      for (const x of old) await f(`${drive}/items/${x.id}`, { method: 'DELETE', headers: H });
      st.removed = old.length;
    }
    st.ok = true;
  } catch (e) { st.error = String(e && e.message || e).slice(0, 300) }
  try { await store.set('backup/status', JSON.stringify(st)) } catch {}
  return st;
}
