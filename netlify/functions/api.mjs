import { getStore } from '@netlify/blobs';
import { makeHandler } from './lib.mjs';

export const config = { path: '/api/*' };

const raw = getStore({ name: 'imt-db', consistency: 'strong' });
// إعادة محاولة تلقائية عند أعطال Blobs العابرة (BlobsInternalError / 5xx)
const transient = (e) => /Internal|5\d\d|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(String(e && (e.name + ' ' + e.message)));
const store = new Proxy(raw, {
  get(t, k) {
    const f = t[k]; if (typeof f !== 'function') return f;
    return async (...a) => {
      for (let i = 0; ; i++) {
        try { return await f.apply(t, a) } catch (e) { if (i >= 3 || !transient(e)) throw e; await new Promise((r) => setTimeout(r, 150 * (i + 1) + Math.random() * 100)) }
      }
    };
  },
});
const handle = makeHandler(store, process.env);

export default async (req) => handle(req);
