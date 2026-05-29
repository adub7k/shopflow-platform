// ── Utilities ─────────────────────────────────────────────────────────────────
const genId = (p='x') => p+Date.now().toString(36)+Math.random().toString(36).slice(2,4);
const today = () => new Date().toISOString().split('T')[0];
const fmtMoney = (n) => '$'+(Number(n)||0).toFixed(2).replace(/\.00$/,'').replace(/\B(?=(\d{3})+(?!\d))/g,',');
const fmtDateShort = (d) => { if(!d)return '—'; const dt=new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-US',{month:'short',day:'numeric'}); };
const fmtDateFull = (d) => { if(!d)return '—'; const dt=new Date(d+'T12:00:00'); return dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); };
const initials = (name) => (name||'?').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
const avatarColor = (name) => { const colors=['#16a34a','#2563eb','#d97706','#7c3aed','#dc2626','#0891b2']; let h=0; for(const c of (name||'?'))h=c.charCodeAt(0)+((h<<5)-h); return colors[Math.abs(h)%colors.length]; };
const avatarEl = (name, size=36) => `<div class="avatar" style="width:${size}px;height:${size}px;background:${avatarColor(name)};">${initials(name)}</div>`;
const statusBadge = (s) => { const m={confirmed:'badge-green',done:'badge-blue','in-progress':'badge-yellow',cancelled:'badge-red','no-show':'badge-red',pending:'badge-gray'}; return `<span class="badge ${m[s]||'badge-gray'}">${s}</span>`; };
const disableBtn = (btn) => { if(btn){btn.disabled=true;btn._txt=btn.innerHTML;btn.innerHTML='<span style="opacity:.5">Saving...</span>';} };
const enableBtn  = (btn) => { if(btn){btn.disabled=false;btn.innerHTML=btn._txt||btn.innerHTML;} };

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
        list.innerHTML=results.slice(0,6).map(c=>`<div class="autocomplete-item" data-id="${c.id}" data-name="${c.name}">${c.name}<span style="font-size:11px;color:var(--faint);margin-left:6px;">${c.phone||''}</span></div>`).join('');
        list.classList.add('open');
        list.querySelectorAll('.autocomplete-item').forEach(item=>{
          item.addEventListener('click',()=>{ onSelect(item.dataset.id,item.dataset.name); list.classList.remove('open'); });
        });
      }catch(e){}
    },300);
  });
  document.addEventListener('click',e=>{if(!input.contains(e.target)&&!list.contains(e.target))list.classList.remove('open');});
}
