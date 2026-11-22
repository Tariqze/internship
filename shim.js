/* طبقة توافق: تجعل الصفحة تعمل على Netlify بدل منصة Claude. تعمل فقط إن لم يوجد window.claude. */
(function(){
if(window.claude&&window.claude.use)return;
window.IMT_NETLIFY=true;
const api0=async(p,b)=>{const r=await fetch('/api'+p,{method:b?'POST':'GET',headers:b?{'content-type':'application/json'}:undefined,body:b?JSON.stringify(b):undefined,credentials:'same-origin'});let j={};try{j=await r.json()}catch(e){}if(!r.ok){const e=new Error(j.error||('http_'+r.status));e.code=j.error||('http_'+r.status);throw e}return j};
const api=async(p,b)=>{for(let i=0;;i++){try{return await api0(p,b)}catch(e){const c=String(e&&e.code||'');const tr=/^(internal|http_5\d\d)$/.test(c)||e instanceof TypeError;if(!tr||i>=3||p==='/db/add'||p==='/login')throw e;await new Promise(r=>setTimeout(r,400*(i+1)+Math.random()*300))}}};
const clone=d=>d==null?d:JSON.parse(JSON.stringify(d));
const snap=(id,d)=>({id,exists:d!=null,data:()=>clone(d)});
const subs=new Set();let timer=null,vers={},busy=false;
let bulkN=0;const poke=()=>{if(bulkN)return;if(timer)clearTimeout(timer);timer=setTimeout(poll,60)};window.IMT_BULK=on=>{bulkN=Math.max(0,bulkN+(on?1:-1));if(!bulkN)poke()};
async function poll(){
  if(busy||!subs.size){schedule();return}busy=true;
  try{
    const cs=[...new Set([...subs].map(s=>s.col))],v=await api('/db/ver?cs='+cs.join(','));
    await Promise.all([...subs].filter(s=>s.stale||vers[s.col]!==v[s.col]||s.first).map(async s=>{s.stale=false;const f=s.first;s.first=false;try{await s.run(f)}catch(e){if(s.err)s.err(e)}}));
    vers={...v};
  }catch(e){}finally{busy=false;schedule()}
}
function schedule(){clearTimeout(timer);timer=setTimeout(poll,document.hidden?15000:3000+Math.floor(Math.random()*1500))}
function addSub(col,run,err){const s={col,run,err,first:true};subs.add(s);poke();return()=>subs.delete(s)}
const qs=(c,f,l)=>'/db/col?c='+encodeURIComponent(c)+'&q='+encodeURIComponent(JSON.stringify(f||[]))+(l?'&l='+l:'');
const mkQuery=(c,f,l)=>({
  where:(a,o,v)=>mkQuery(c,[...f,[a,o,v]],l),limit:n=>mkQuery(c,f,n),
  async get(){const r=await api(qs(c,f,l));const docs=r.docs.map(x=>snap(x.id,x.data));return{docs,size:docs.length,empty:!docs.length}},
  onSnapshot(fn,err){let last='';return addSub(c,async()=>{const r=await api(qs(c,f,l)),j=JSON.stringify(r.docs);if(j===last)return;last=j;const docs=r.docs.map(x=>snap(x.id,x.data));fn({docs,size:docs.length,empty:!docs.length})},err)}
});
const docRef=(p)=>{const[c,id]=p.split('/');return{id,path:p,
  async get(){const r=await api('/db/doc?p='+encodeURIComponent(p));return snap(id,r.data)},
  async set(d){await api('/db/set',{p,data:d});poke()},
  async update(d){await api('/db/update',{p,data:d});poke()},
  async delete(){await api('/db/delete',{p});poke()},
  async slotOp(o){const r=await api('/db/slot',o);poke();return r},
  async acquire(o){return api('/db/lease',{p,holder:o.holder,ttlMs:o.ttlMs})},
  onSnapshot(fn,err){let last='';return addSub(c,async()=>{const r=await api('/db/doc?p='+encodeURIComponent(p)),j=JSON.stringify(r.data);if(j===last)return;last=j;fn(snap(id,r.data))},err)}}};
const colRef=(c)=>({...mkQuery(c,[],0),path:c,doc:id=>docRef(c+'/'+id),async add(d){const r=await api('/db/add',{c,data:d});poke();return docRef(c+'/'+r.id)}});
const db={doc:docRef,collection:colRef};
const user={id:async()=>'anon',isOwner:()=>false,canEdit:()=>false,can:()=>null};
const downloads={async save({filename,data}){const a=document.createElement('a');a.href=URL.createObjectURL(data);a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},2000)}};
let cfg=null;const getCfg=async()=>cfg||(cfg=await api('/config').catch(()=>({sample:false})));
const b64=async blob=>{const u=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));return btoa(s)};
const sample=async()=>{throw{code:'unsupported'}};
sample.json=async(prompt,o)=>{const img=o&&o.images&&o.images[0];if(!img)throw{code:'unsupported'};try{const r=await api('/read-form',{prompt,image:await b64(img),mime:img.type||'image/jpeg'});return r.json}catch(e){throw{code:e.code==='permission-denied'?'not_granted':e.code||'error',message:e.message}}};
sample.limits=async()=>(await getCfg()).sample?{images:{maxCount:1}}:{};
window.claude={use:async n=>n==='db'?db:n==='user'?user:n==='downloads'?downloads:n==='sample'?((await getCfg()).sample?sample:null):null};
})();
