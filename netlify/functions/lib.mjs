// منطق الخادم لنظام تدريب الامتياز (نموذج تجريبي) — مستقل عن Netlify ليسهل اختباره.
// للنموذج التجريبي فقط: كلمة السر = السجل المدني، والقاعدة مفتوحة للمستخدم المسجَّل وفق قواعد أدوار مبسطة.
import crypto from 'node:crypto';
import { backupKey, backupConfigured } from './backup-lib.mjs';

const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const AR = '٠١٢٣٤٥٦٧٨٩';
const norm = (s) => String(s ?? '').trim().replace(/[٠-٩]/g, (c) => AR.indexOf(c)).replace(/\s+/g, '');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const SAFE = /^[A-Za-z0-9_.\-]{1,80}$/;
const PW_MIN = 8;
const hashPw = (salt, pw) => crypto.scryptSync(String(pw), String(salt), 32).toString('hex');
// يعيد 'hash' إن طابقت كلمة مرور غيّرها المستخدم، و'init' إن طابقت الكلمة الأولية (أو السجل المدني لسجل قديم)، وإلا null
const checkPw = (m, pw) => {
  if (!m) return null;
  if (m.ph) return m.ps && eq(hashPw(m.ps, pw), m.ph) ? 'hash' : null;
  const init = norm(m.pw ?? m.nid); return init && eq(norm(pw), init) ? 'init' : null;
};
const pub = (m) => { if (!m) return m; const { pw, ph, ps, ...r } = m; return r };

const retryOp = async (fn, n = 4) => { let e; for (let i = 0; i < n; i++) { try { return await fn() } catch (x) { e = x; await new Promise((r) => setTimeout(r, 120 * (i + 1) * (1 + Math.random()))) } } throw e };
const hardenStore = (raw) => ({ get: (...a) => retryOp(() => raw.get(...a)), getWithMetadata: (...a) => retryOp(() => raw.getWithMetadata(...a)), set: (...a) => retryOp(() => raw.set(...a)), delete: (...a) => retryOp(() => raw.delete(...a)), list: (...a) => retryOp(() => raw.list(...a)) });
export function makeHandler(store0, env) {
  const store = hardenStore(store0);
  const SECRET = env.SESSION_SECRET || ('imt:' + (env.OWNER_PASSWORD || 'change-me'));
  const COOKIE = 'imt_s', TTL = 12 * 3600 * 1000;
  const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  const mint = (o) => { const p = Buffer.from(JSON.stringify({ ...o, exp: Date.now() + TTL })).toString('base64url'); return p + '.' + sign(p); };
  const readSess = (req) => {
    const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)imt_s=([^;]+)/); if (!m) return null;
    const [p, sg] = m[1].split('.'); if (!p || !sg || !eq(sg, sign(p))) return null;
    try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null } catch { return null }
  };
  const cookie = (v, maxAge) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

  // ---------- مخزن المستندات ----------
  const K = (c, id) => `d/${c}/${id}`;
  // ذاكرة مؤقتة داخل النسخة الدافئة من الدالة: تقلّل قراءات التخزين عند كثرة المتصفحات المفتوحة.
  const VER = new Map(), COL = new Map(), VER_TTL = env.NO_CACHE ? 0 : 1000, COL_TTL = env.NO_CACHE ? 0 : 30000;
  const bump = (c) => { VER.delete(c); COL.delete(c); return store.set(`v/${c}`, String(Date.now()) + Math.random().toString(36).slice(2, 6)).catch((e) => console.error('bump', c, e)) };
  const verOf = async (c) => { const h = VER.get(c), now = Date.now(); if (h && now - h.t < VER_TTL) return h.v; const v = (await store.get(`v/${c}`)) || '0'; VER.set(c, { v, t: now }); return v };
  const getDoc = async (c, id) => { const t = await store.get(K(c, id)); return t == null ? null : JSON.parse(t) };
  const listCol0 = async (c) => {
    const { blobs } = await store.list({ prefix: `d/${c}/` }); const out = [];
    for (let i = 0; i < blobs.length; i += 25) {
      const part = await Promise.all(blobs.slice(i, i + 25).map(async (b) => { const t = await store.get(b.key); return t == null ? null : { id: b.key.slice(`d/${c}/`.length), data: JSON.parse(t) } }));
      part.forEach((x) => x && out.push(x));
    }
    return out;
  };
  const listCol = async (c) => {
    const v = await verOf(c), h = COL.get(c);
    if (v !== '0' && h && h.v === v && Date.now() - h.t < COL_TTL) return h.list;
    const list = await listCol0(c); if (v !== '0') COL.set(c, { v, t: Date.now(), list }); return list;
  };
  const clean = (s, c, d) => {
    if (!d) return d;
    if ((c === 'students' || c === 'staff') && s.role !== 'coordinator' && s.role !== 'owner') return pub(d);
    // خصوصية: لا يرى الطبيب أعذار زملائه في طلبات التعديل، فقط بيانات الدور
    if (c === 'changes' && s.role === 'student' && d.uid !== s.acct) { const { reason, reasonType, name, att, ...r } = d; return r }
    return d;
  };
  const test = (d, [f, op, v]) => { const x = d?.[f]; switch (op) { case '==': return x === v; case '!=': return x !== v; case '<': return x < v; case '<=': return x <= v; case '>': return x > v; case '>=': return x >= v; default: return false } };

  // ---------- الصلاحيات (مبسطة) ----------
  const OWN_ID = new Set(['users', 'bookings', 'queue']);
  const OWN_UID = new Set(['elapp', 'leaves', 'evals', 'externals', 'postpones', 'docs', 'evfiles', 'survresp']);
  const S_DENY = new Set(['students', 'staff', 'outbox']);
  const S_NOWRITE = new Set(['students', 'staff', 'outbox', 'config', 'hospitals', 'specs', 'capacity', 'assets', 'orient', 'oratt', 'clear', 'elwin', 'elcap']);
  const SUP_NOWRITE = new Set(['students', 'staff', 'outbox', 'config', 'hospitals', 'specs', 'capacity', 'assets']);
  const CENTER_W = new Set(['orient', 'oratt', 'clear', 'evals', 'evfiles', 'elwin', 'elcap', 'elapp', 'slots', 'bookings']);
  const canRead = (s, c, id, d) => {
    if (!s) return false;
    if (s.role === 'center' && (c === 'staff' || c === 'outbox' || c === 'audit')) return false;
    if (s.role !== 'student') return true;
    if (S_DENY.has(c) || c === 'audit') return false;
    if (OWN_ID.has(c)) return c === 'queue' ? true : id === s.acct;
    if (OWN_UID.has(c)) return d ? d.uid === s.acct : true;
    return true;
  };
  const canWrite = (s, c, id, d, old) => {
    if (!s) return false;
    if (s.role === 'coordinator' || s.role === 'owner') return true;
    if (c === 'staff' || c === 'students') return false;
    if (s.role === 'center') { if (c === 'audit') return !old; if (c === 'users') return id === s.acct; return CENTER_W.has(c) }
    if (s.role === 'supervisor') return !SUP_NOWRITE.has(c);
    if (S_NOWRITE.has(c)) return false;
    if (c === 'audit') return !old;
    if (c === 'elapp') return id.endsWith('_' + s.acct) && (!d || (d.uid === s.acct && d.status === 'pending')) && (!old || old.status === 'pending');
    if (c === 'orbook') return id.endsWith('_' + s.acct) && (!d || d.uid === s.acct);
    if (c === 'users' || c === 'bookings' || c === 'queue') return id === s.acct;
    if (OWN_UID.has(c)) { const own = (d && d.uid === s.acct) || (!d && old && old.uid === s.acct); return !!own && (!old || old.uid === s.acct) }
    return true;
  };

  async function login(req) {
    const b = await req.json().catch(() => ({})); const kind = b.kind, pw = norm(b.pw), id = norm(b.id).toLowerCase();
    if (!['st', 'sf', 'ow'].includes(kind) || !pw) return json({ error: 'badlogin' }, 400);
    const lk = `lock/${kind}_${id || 'owner'}`, lk0 = await store.get(lk), L = lk0 ? JSON.parse(lk0) : { n: 0, until: 0 };
    if (L.until > Date.now()) return json({ error: 'locked' }, 429);
    const fail = async () => { L.n = (L.n || 0) + 1; if (L.n >= 5) { L.until = Date.now() + 15 * 60000; L.n = 0 } await store.set(lk, JSON.stringify(L)); return json({ error: 'badlogin' }, 401) };
    let sess, record = null;
    if (kind === 'ow') {
      if (!env.OWNER_PASSWORD || !eq(pw, env.OWNER_PASSWORD)) return fail();
      sess = { acct: 'owner', role: 'owner', owner: true };
    } else if (kind === 'st') {
      if (!SAFE.test(id)) return fail();
      const m = await getDoc('students', id); if (!m || norm(m.studentId) !== id) return fail();
      const r = checkPw(m, pw); if (!r) return fail();
      record = pub(m); sess = { acct: 's_' + id, role: 'student', owner: false, kind: 'st', id, ...(r === 'init' ? { must: true } : {}) };
      if (!sess.must) { await store.set(K('students', id), JSON.stringify({ ...m, uid: sess.acct })); await bump('students') }
    } else {
      if (!SAFE.test(id)) return fail();
      const m = await getDoc('staff', id); const r = checkPw(m, pw); if (!r) return fail();
      record = pub(m); sess = { acct: 'u_' + id, role: (m.title === 'tcenter' || m.role === 'center') ? 'center' : (m.role === 'coordinator' ? 'coordinator' : 'supervisor'), owner: false, kind: 'sf', id, ...(r === 'init' ? { must: true } : {}) };
    }
    await store.set(lk, JSON.stringify({ n: 0, until: 0 }));
    return json({ acct: sess.acct, owner: sess.owner, role: sess.role, must: !!sess.must, kind: sess.kind, id: sess.id, record }, 200, { 'set-cookie': cookie(mint(sess), TTL / 1000) });
  }

  async function changePw(req, s) {
    if (!s.kind || !s.id) return json({ error: 'permission-denied' }, 403);
    const b = await req.json().catch(() => ({})), oldPw = norm(b.old), np = String(b.pw ?? '').trim();
    const col = s.kind === 'st' ? 'students' : 'staff', m = await getDoc(col, s.id);
    if (!m || !checkPw(m, oldPw)) return json({ error: 'badold' }, 400);
    if (np.length < PW_MIN) return json({ error: 'pwshort' }, 400);
    if (eq(np, oldPw) || (m.nid && eq(norm(np), norm(m.nid))) || np.toLowerCase() === String(s.id).toLowerCase()) return json({ error: 'pwweak' }, 400);
    const ps = crypto.randomBytes(12).toString('hex'), d = { ...m, ps, ph: hashPw(ps, np) }; delete d.pw;
    if (s.kind === 'st') d.uid = s.acct;
    await store.set(K(col, s.id), JSON.stringify(d)); await bump(col);
    const ns = { acct: s.acct, role: s.role, owner: false, kind: s.kind, id: s.id };
    return json({ ok: true, record: pub(d) }, 200, { 'set-cookie': cookie(mint(ns), TTL / 1000) });
  }

  async function readForm(req, s) {
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'nosample' }, 501);
    const b = await req.json().catch(() => ({})); if (!b.image || !b.prompt) return json({ error: 'bad' }, 400);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 1800, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: b.mime || 'image/jpeg', data: b.image } }, { type: 'text', text: b.prompt }] }] }),
    });
    if (!r.ok) return json({ error: 'upstream_' + r.status }, 502);
    const j = await r.json(); const text = (j.content || []).map((x) => x.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/); if (!m) return json({ error: 'parse' }, 502);
    try { return json({ json: JSON.parse(m[0]) }) } catch { return json({ error: 'parse' }, 502) }
  }

  return async function handle(req) {
    const url = new URL(req.url), p = url.pathname.replace(/^\/api/, '') || '/';
    try {
      if (p === '/health') {
        const h = { ok: true, owner_password: !!env.OWNER_PASSWORD, session_secret: !!env.SESSION_SECRET, sample: !!env.ANTHROPIC_API_KEY, storage: false };
        try { await store.set('health/ping', String(Date.now())); h.storage = (await store.get('health/ping')) != null } catch (e) { h.ok = false; h.storage_error = String(e && e.name || e).slice(0, 80) }
        return json(h);
      }
      if (p === '/config') return json({ sample: !!env.ANTHROPIC_API_KEY });
      if (p === '/login' && req.method === 'POST') return await login(req);
      if (p === '/logout') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
      const s = readSess(req);
      if (p === '/me') return json(s ? { acct: s.acct, owner: !!s.owner, role: s.role, must: !!s.must, kind: s.kind, id: s.id } : {});
      if (!s) return json({ error: 'permission-denied' }, 401);
      if (p === '/change-password' && req.method === 'POST') return await changePw(req, s);
      if (s.must) return json({ error: 'mustchange' }, 403);
      if (p === '/read-form' && req.method === 'POST') return await readForm(req, s);
      if (p === '/backup/status') {
        if (!s.owner) return json({ error: 'permission-denied' }, 403);
        let st = null; try { const t = await store.get('backup/status'); st = t ? JSON.parse(t) : null } catch {}
        return json({ configured: backupConfigured(env), folder: env.MS_FOLDER || 'IMT-Backups', keep: parseInt(env.BACKUP_KEEP || '30', 10) || 30, last: st });
      }
      if (p === '/backup/run' && req.method === 'POST') {
        if (!s.owner) return json({ error: 'permission-denied' }, 403);
        if (!backupConfigured(env)) return json({ error: 'not-configured' }, 400);
        const base = env.URL || new URL(req.url).origin;
        try { const r = await (env.__fetch || fetch)(base + '/.netlify/functions/backup-background', { method: 'POST', headers: { 'x-backup-key': backupKey(env) } }); return json({ started: r.status < 300 || r.status === 202 }) }
        catch { return json({ error: 'trigger-failed' }, 502) }
      }

      if (p === '/db/ver') {
        const cs = (url.searchParams.get('cs') || '').split(',').filter((x) => SAFE.test(x)).slice(0, 30), o = {};
        await Promise.all(cs.map(async (c) => { o[c] = await verOf(c) })); return json(o);
      }
      if (p === '/db/doc') {
        const [c, id] = (url.searchParams.get('p') || '').split('/'); if (!SAFE.test(c || '') || !SAFE.test(id || '')) return json({ error: 'invalid_argument' }, 400);
        const d = await getDoc(c, id); if (d && !canRead(s, c, id, d)) return json({ data: null });
        if (!d && !canRead(s, c, id, null)) return json({ error: 'permission-denied' }, 403);
        return json({ data: clean(s, c, d) });
      }
      if (p === '/db/col') {
        const c = url.searchParams.get('c') || ''; if (!SAFE.test(c)) return json({ error: 'invalid_argument' }, 400);
        if (s.role === 'student' && (S_DENY.has(c) || c === 'audit')) return json({ error: 'permission-denied' }, 403);
        const f = JSON.parse(url.searchParams.get('q') || '[]'), lim = +url.searchParams.get('l') || 0;
        let docs = (await listCol(c)).filter((x) => canRead(s, c, x.id, x.data) && f.every((t) => test(x.data, t)));
        if (lim) docs = docs.slice(0, lim); return json({ docs: docs.map((x) => ({ id: x.id, data: clean(s, c, x.data) })) });
      }
      if (req.method === 'POST' && p.startsWith('/db/')) {
        const b = await req.json().catch(() => ({}));
        if (p === '/db/slot') {
          // عملية ذرّية على مقعد: claim / release / cap (تفاؤلية بالـ etag مع إعادة المحاولة)
          const op = String(b.op || ''), hid = String(b.hid || ''), spec = String(b.spec || ''), ym = String(b.ym || ''), uid = String(b.uid || '');
          const id = `${hid}_${spec}_${ym}`; if (!SAFE.test(id) || !['claim', 'release', 'cap'].includes(op)) return json({ error: 'invalid_argument' }, 400);
          if (s.role === 'student' ? (op === 'cap' || uid !== s.acct || b.force) : !canWrite(s, 'slots', id, null, null)) return json({ error: 'permission-denied' }, 403);
          const key = K('slots', id);
          for (let i = 0; i < 60; i++) {
            const cur = await store.getWithMetadata(key), d = cur?.data ? JSON.parse(cur.data) : {}, booked = Array.isArray(d.booked) ? d.booked : [];
            let nb = booked, ncap = d.cap;
            if (op === 'claim') { if (booked.includes(uid)) return json({ ok: true, booked: booked.length }); const cap = d.cap != null ? d.cap : +b.cap; if (!b.force && booked.length >= cap) return json({ full: true, booked: booked.length }); nb = [...booked, uid] }
            else if (op === 'release') { if (!booked.includes(uid)) return json({ ok: true, booked: booked.length }); nb = booked.filter((x) => x !== uid) }
            else { if (b.cap === null || b.cap === undefined) ncap = undefined; else ncap = +b.cap }
            const body = { hid, spec, ym, booked: nb, ...(ncap != null ? { cap: ncap } : {}) };
            const val = JSON.stringify(body);
            const r = cur?.data != null ? await store.set(key, val, { onlyIfMatch: cur.etag }) : await store.set(key, val, { onlyIfNew: true });
            if (r?.modified !== false) { await bump('slots'); return json({ ok: true, booked: nb.length }) }
            if (i > 3) await new Promise((r2) => setTimeout(r2, Math.random() * 8 * i));
          }
          return json({ busy: true });
        }
        if (p === '/db/lease') {
          const [c, id] = String(b.p || '').split('/'); if (!SAFE.test(c || '') || !SAFE.test(id || '')) return json({ error: 'invalid_argument' }, 400);
          const key = `l/${c}/${id}`, cur = await store.getWithMetadata(key), now = Date.now(), L = cur?.data ? JSON.parse(cur.data) : null;
          if (L && L.exp > now && L.h !== b.holder) return json({ acquired: false });
          const val = JSON.stringify({ h: b.holder, exp: now + Math.min(+b.ttlMs || 1000, 30000) });
          const r = cur ? await store.set(key, val, { onlyIfMatch: cur.etag }) : await store.set(key, val, { onlyIfNew: true });
          return json({ acquired: r?.modified !== false });
        }
        let c, id; if (p === '/db/add') { c = String(b.c || ''); id = 'a' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex') } else [c, id] = String(b.p || '').split('/');
        if (!SAFE.test(c || '') || !SAFE.test(id || '')) return json({ error: 'invalid_argument' }, 400);
        const old = await getDoc(c, id);
        if (p === '/db/delete') { if (!canWrite(s, c, id, null, old)) return json({ error: 'permission-denied' }, 403); await store.delete(K(c, id)); await bump(c); return json({ ok: true }) }
        if (!b.data || typeof b.data !== 'object') return json({ error: 'invalid_argument' }, 400);
        if (JSON.stringify(b.data).length > 900000) return json({ error: 'invalid_argument' }, 400);
        if (p === '/db/update') { if (!old) return json({ error: 'not-found' }, 404); const d = { ...old, ...b.data }; if (!canWrite(s, c, id, d, old)) return json({ error: 'permission-denied' }, 403); await store.set(K(c, id), JSON.stringify(d)); await bump(c); return json({ ok: true }) }
        if (p === '/db/set' || p === '/db/add') { if (!canWrite(s, c, id, b.data, old)) return json({ error: 'permission-denied' }, 403); await store.set(K(c, id), JSON.stringify(b.data)); await bump(c); return json({ ok: true, id }) }
      }
      return json({ error: 'not_found' }, 404);
    } catch (e) { console.error('api', e); return json({ error: 'internal' }, 500) }
  };
}
