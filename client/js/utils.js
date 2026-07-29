// ── Utilities ─────────────────────────────────────────────────────────────────

// Global shop profile (vocabulary, custom fields, statuses) — populated at boot
// from db.settings.get(). Falls back to barbershop terms if a shop has none.
const Shop = { settings:{}, industry:'barbershop', vocab:{}, fields:[], statuses:[], sizes:[], addons:[], membershipPlans:[], serviceCategories:[], supportsQuotes:false, tax:{enabled:false,rate:0,label:'Sales Tax'} };
function V(key, fb){ return (Shop.vocab && Shop.vocab[key]) || fb; }

// Resolve a service's price for a given vehicle size class. Falls back to the
// flat price when the service has no per-size table or the size isn't set.
function servicePrice(svc, sizeKey){
  if (svc && svc.sizePricing && sizeKey && svc.sizePricing[sizeKey] != null && svc.sizePricing[sizeKey] !== '')
    return Number(svc.sizePricing[sizeKey]);
  return Number(svc && svc.price) || 0;
}
function statusMeta(key){ return (Shop.statuses||[]).find(s=>s.key===key) || null; }
function statusLabel(key){
  const m = statusMeta(key);
  if (m) return m.label;
  return ({'pending-deposit':'deposit pending','no-show':'no show','in-progress':'in progress'})[key] || key;
}

const genId = (p='x') => p+Date.now().toString(36)+Math.random().toString(36).slice(2,4);
const today = () => new Date().toISOString().split('T')[0];
const fmtMoney = (n) => '$'+(Number(n)||0).toFixed(2).replace(/\.00$/,'').replace(/\B(?=(\d{3})+(?!\d))/g,',');
const fmtDateShort = (d) => { if(!d)return '—'; const dt=new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-US',{month:'short',day:'numeric'}); };
const fmtDateFull = (d) => { if(!d)return '—'; const dt=new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); };
const initials = (name) => (name||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
const avatarColor = (name) => { const colors=['#16a34a','#2563eb','#d97706','#7c3aed','#dc2626','#0891b2']; let h=0; for(const c of (name||'?'))h=c.charCodeAt(0)+((h<<5)-h); return colors[Math.abs(h)%colors.length]; };
const avatarEl = (name, size=36) => `<div class="avatar" style="width:${size}px;height:${size}px;background:${avatarColor(name)};">${initials(name)}</div>`;
const statusBadge = (s) => { const m={confirmed:'badge-green',done:'badge-blue','in-progress':'badge-yellow',cancelled:'badge-red','no-show':'badge-red',pending:'badge-gray','pending-deposit':'badge-yellow','dropped-off':'badge-yellow',curing:'badge-yellow',ready:'badge-green'}; return `<span class="badge ${m[s]||'badge-gray'}">${statusLabel(s)}</span>`; };
const disableBtn = (btn) => { if(btn){btn.disabled=true;btn._txt=btn.innerHTML;btn.innerHTML='<span style="opacity:.5">Saving...</span>';} };
const enableBtn  = (btn) => { if(btn){btn.disabled=false;btn.innerHTML=btn._txt||btn.innerHTML;} };

// HTML-escape for text content and double-quoted attribute values.
const esc = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// Escape for a value placed inside a SINGLE-QUOTED JS string that itself lives in
// a double-quoted HTML attribute, e.g. onclick="Fn('${jsAttr(x)}')". Plain esc()
// is NOT safe here: the browser HTML-decodes the attribute before the JS parser
// runs, so an esc()'d apostrophe (&#39;) turns back into ' and breaks out of the
// string. Backslash-escape the JS metacharacters first, then HTML-encode the
// attribute-breaking chars. Prefer passing IDs only; use this for any free text.
const jsAttr = (s) => String(s==null?'':s)
  .replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\r/g,'\\r').replace(/\n/g,'\\n')
  .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Read an image File and return a downscaled JPEG data URL (keeps phone photos
// well under the server's 5MB upload limit). Used by gallery + job photos.
function downscaleImage(file, maxDim=1280, quality=0.82) {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>{ const img=new Image(); img.onload=()=>{
      const w=img.width,h=img.height; const sc=Math.min(1,maxDim/Math.max(w,h));
      const cw=Math.max(1,Math.round(w*sc)),ch=Math.max(1,Math.round(h*sc));
      const c=document.createElement('canvas'); c.width=cw; c.height=ch;
      c.getContext('2d').drawImage(img,0,0,cw,ch);
      resolve(c.toDataURL('image/jpeg',quality));
    }; img.onerror=()=>reject(new Error('Invalid image')); img.src=reader.result; };
    reader.onerror=()=>reject(new Error('Could not read file')); reader.readAsDataURL(file);
  });
}

let _toastTimer;
function toast(msg, type='') {
  const el=document.getElementById('toast'); if(!el)return;
  el.textContent=msg; el.className='show';
  if(type==='error')el.style.background='#dc2626';
  else if(type==='warning')el.style.background='#d97706';
  else el.style.background='#111827';
  clearTimeout(_toastTimer); _toastTimer=setTimeout(()=>{el.className='';},2800);
}

const Modal = {
  show(html) { const box=document.getElementById('modal-box'); if(box)box.innerHTML=html; const ov=document.getElementById('modal-overlay'); if(ov){ov.classList.add('open');document.body.style.overflow='hidden';} },
  close() { const ov=document.getElementById('modal-overlay'); if(ov){ov.classList.remove('open');document.body.style.overflow='';} }
};

function makeAutocomplete(inputId, listId, onSelect) {
  const input=document.getElementById(inputId), list=document.getElementById(listId);
  if(!input||!list)return;
  let timer;
  input.addEventListener('input',()=>{
    clearTimeout(timer);
    const q=input.value.trim();
    if(q.length<2){list.classList.remove('open');list.innerHTML='';return;}
    timer=setTimeout(async()=>{
      try{
        const results=await db.customers.search(q);
        if(!results.length){list.classList.remove('open');return;}
        list.innerHTML=results.slice(0,6).map(c=>`<div class="autocomplete-item" data-id="${c.id}" data-name="${esc(c.name)}" data-phone="${c.phone||''}" data-email="${esc(c.email||'')}">${c.name}<span style="font-size:11px;color:var(--faint);margin-left:6px;">${c.phone||''}</span></div>`).join('');
        list.classList.add('open');
        list.querySelectorAll('.autocomplete-item').forEach(item=>{
          // 4th arg (email) is additive — existing callers ignore it.
          item.addEventListener('click',()=>{ onSelect(item.dataset.id,item.dataset.name,item.dataset.phone||'',item.dataset.email||''); list.classList.remove('open'); });
        });
      }catch(e){}
    },300);
  });
  document.addEventListener('click',e=>{if(!input.contains(e.target)&&!list.contains(e.target))list.classList.remove('open');});
}
