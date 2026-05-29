// ── PIN Auth ──────────────────────────────────────────────────────────────────
const Auth = {
  _unlocked: false,
  SESSION_KEY: 'sf_auth',

  isUnlocked() { return this._unlocked || sessionStorage.getItem(this.SESSION_KEY)==='1'; },

  async init() { if(this.isUnlocked()){this._unlocked=true;return true;} return false; },

  showLock() {
    const el = document.createElement('div');
    el.id = 'pin-overlay';
    el.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
    el.innerHTML = `
      <div style="text-align:center;max-width:300px;width:100%;padding:24px;">
        <img src="/icons/icon-192.png" style="width:80px;height:80px;border-radius:18px;margin:0 auto 16px;display:block;" />
        <div style="font-size:13px;color:#6b7280;margin-bottom:28px;" id="pin-shop-name">Enter your PIN to continue</div>
        <div id="pin-dots" style="display:flex;gap:12px;justify-content:center;margin-bottom:24px;">
          ${[0,1,2,3].map(()=>'<div class="pdot" style="width:13px;height:13px;border-radius:50%;background:#e5e7eb;border:2px solid #d1d5db;transition:all .15s;"></div>').join('')}
        </div>
        <div id="pin-err" style="display:none;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;color:#dc2626;margin-bottom:16px;">Incorrect PIN. Try again.</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:220px;margin:0 auto;">
          ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(n=>`<button onclick="Auth._key('${n}')" style="background:${n===''?'transparent':'#f9fafb'};border:${n===''?'none':'1px solid #e5e7eb'};border-radius:10px;padding:16px 0;font-size:${n==='⌫'?'18px':'20px'};font-weight:600;color:#111;cursor:${n===''?'default':'pointer'};font-family:inherit;${n===''?'pointer-events:none;':''}" ${n===''?'disabled':''}>${n}</button>`).join('')}
        </div>
        <div style="margin-top:16px;">
          <button onclick="Auth.showResetPIN()" style="background:none;border:none;font-size:12px;color:#9ca3af;cursor:pointer;text-decoration:underline;font-family:inherit;">Forgot PIN?</button>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#9ca3af;">Powered by <strong style="color:#16a34a;">ShopFlow</strong></div>
      </div>`;
    document.body.appendChild(el);
    this._pin = '';
    // Load shop name
    fetch('/api/settings').then(r=>r.json()).then(s=>{ const el2=document.getElementById('pin-shop-name'); if(el2&&s.shopName)el2.textContent='Welcome to '+s.shopName; }).catch(()=>{});
  },

  _pin: '',

  _key(k) {
    if(k==='⌫'){this._pin=this._pin.slice(0,-1);this._dots();return;}
    if(k===''||this._pin.length>=4)return;
    this._pin+=String(k); this._dots();
    if(this._pin.length===4)setTimeout(()=>this._verify(),120);
  },

  _dots() {
    document.querySelectorAll('.pdot').forEach((d,i)=>{
      d.style.background=i<this._pin.length?'#16a34a':'#e5e7eb';
      d.style.borderColor=i<this._pin.length?'#16a34a':'#d1d5db';
    });
  },

  async _verify() {
    try {
      const data = await db.auth.verify(this._pin);
      if(data.ok){
        this._unlocked=true;
        sessionStorage.setItem(this.SESSION_KEY,'1');
        const ov=document.getElementById('pin-overlay');
        if(ov){ov.style.transition='opacity .3s';ov.style.opacity='0';setTimeout(()=>ov.remove(),300);}
      } else {
        this._pin=''; this._dots();
        const err=document.getElementById('pin-err');
        if(err){err.style.display='block';setTimeout(()=>{err.style.display='none';},2000);}
      }
    } catch(e){ this._pin=''; this._dots(); }
  },

  lock() { this._unlocked=false; sessionStorage.removeItem(this.SESSION_KEY); location.reload(); },

  showChangePIN() {
    Modal.show(`
      <div class="modal-title">🔒 Change PIN</div>
      <div class="form-group"><label class="form-label">Current PIN</label><input class="form-input" id="cp-cur" type="password" inputmode="numeric" maxlength="8" /></div>
      <div class="form-group"><label class="form-label">New PIN (4+ digits)</label><input class="form-input" id="cp-new" type="password" inputmode="numeric" maxlength="8" /></div>
      <div class="form-group"><label class="form-label">Confirm new PIN</label><input class="form-input" id="cp-con" type="password" inputmode="numeric" maxlength="8" /></div>
      <div class="modal-actions">
        <button class="btn btn-green btn-full" onclick="Auth.savePin()">Save PIN</button>
        <button class="btn btn-full" onclick="Auth.showResetPIN()">Forgot current PIN?</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
  },

  async savePin() {
    const cur=document.getElementById('cp-cur')?.value.trim();
    const nw=document.getElementById('cp-new')?.value.trim();
    const con=document.getElementById('cp-con')?.value.trim();
    if(!cur||!nw||!con){toast('Fill in all fields','warning');return;}
    if(nw!==con){toast('New PINs do not match','warning');return;}
    if(nw.length<4){toast('PIN must be 4+ digits','warning');return;}
    try{
      const r=await db.auth.changePin(cur,nw);
      if(r.ok){Modal.close();toast('PIN updated ✓');}
      else toast(r.error||'Incorrect current PIN','error');
    }catch(e){toast('Error saving PIN','error');}
  },

  showResetPIN() {
    Modal.show(`
      <div class="modal-title">🔑 Reset PIN</div>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;font-size:13px;color:#92400e;margin-bottom:16px;">
        Use this if you forgot your PIN. You'll need the owner secret key.
      </div>
      <div class="form-group"><label class="form-label">Owner Secret Key</label>
        <input class="form-input" id="rp-key" type="password" placeholder="Contact ShopFlow support for this" />
      </div>
      <div class="form-group"><label class="form-label">New PIN</label>
        <input class="form-input" id="rp-new" type="password" inputmode="numeric" maxlength="8" placeholder="New PIN (4+ digits)" />
      </div>
      <div class="form-group"><label class="form-label">Confirm new PIN</label>
        <input class="form-input" id="rp-con" type="password" inputmode="numeric" maxlength="8" placeholder="Confirm new PIN" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-green btn-full" onclick="Auth.doResetPIN()">Reset PIN</button>
        <button class="btn btn-full" onclick="Modal.close()">Cancel</button>
      </div>`);
    setTimeout(()=>document.getElementById('rp-key')?.focus(),150);
  },

  async doResetPIN() {
    const key = document.getElementById('rp-key')?.value.trim();
    const nw  = document.getElementById('rp-new')?.value.trim();
    const con = document.getElementById('rp-con')?.value.trim();
    if(!key||!nw||!con){toast('Fill in all fields','warning');return;}
    if(nw!==con){toast('PINs do not match','warning');return;}
    if(nw.length<4){toast('PIN must be 4+ digits','warning');return;}
    try{
      const res = await fetch('/api/auth/reset-pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ownerKey:key,newPin:nw})});
      const data = await res.json();
      if(data.ok){
        this._unlocked=true;
        sessionStorage.setItem(this.SESSION_KEY,'1');
        Modal.close();
        toast('PIN reset successfully ✓');
      } else {
        toast(data.error||'Invalid owner key','error');
      }
    }catch(e){toast('Error resetting PIN','error');}
  }
};
