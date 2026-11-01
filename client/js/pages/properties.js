// ── Properties (field-service module) ────────────────────────────────────────
// A property is a service location tied to a customer. Holds the operational
// detail crews need on-site: gate codes, alarm instructions, pets, access notes.
// The size/shape attributes (bedrooms for a cleaner, stories for a pressure
// washer) come from the industry profile's propertyFields.
const PROPERTY_FIELDS_FALLBACK = [
  { key: 'bedrooms', label: 'Bedrooms' }, { key: 'bathrooms', label: 'Bathrooms' }, { key: 'squareFootage', label: 'Square footage' },
];
function propertyFields(){ return (Shop.propertyFields && Shop.propertyFields.length) ? Shop.propertyFields : PROPERTY_FIELDS_FALLBACK; }

const Properties = {
  _props: [], _customers: [],

  async render() {
    const el = document.getElementById('page-properties'); if (!el) return;
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    try {
      const [props, customers] = await Promise.all([ db.properties.all(), db.customers.all().catch(()=>[]) ]);
      this._props = props || [];
      this._customers = customers || [];
      const custName = (id) => (this._customers.find(c=>c.id===id)||{}).name || 'Unassigned';
      const html = [];
      html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><div class="section-header" style="margin:0;">Properties</div><button class="btn btn-green btn-sm" onclick="Properties.edit()">+ Add Property</button></div>');
      if (!this._props.length) {
        html.push('<div class="card empty-state"><div class="empty-icon">🏠</div><div class="empty-text">No properties yet. Add the homes and sites your crews service.</div></div>');
      } else {
        html.push('<div class="list-card">');
        this._props.forEach(p => {
          const tags = [];
          propertyFields().forEach(f => {
            if (!p[f.key]) return;
            if (f.key === 'bedrooms') tags.push(esc(p.bedrooms)+' bd');
            else if (f.key === 'bathrooms') tags.push(esc(p.bathrooms)+' ba');
            else if (f.key === 'squareFootage') tags.push(esc(p.squareFootage)+' sqft');
            else if (f.key === 'stories') tags.push(esc(p.stories)+(/stor/i.test(p.stories)?'':' story'));
            else tags.push(esc(p[f.key]));
          });
          if (p.gateCode)  tags.push('🔑 '+esc(p.gateCode));
          if (p.petInfo)   tags.push('🐾');
          html.push('<div class="list-row"><div class="list-main">'
            + '<div class="list-name">'+esc(p.label || p.address)+'</div>'
            + '<div class="list-sub">'+esc(custName(p.customerId))+(p.label?' · '+esc(p.address):'')+'</div>'
            + (tags.length?'<div style="font-size:12px;color:var(--muted);margin-top:3px;">'+tags.join(' · ')+'</div>':'')
            + '</div><div class="list-right" style="display:flex;gap:6px;">'
            + '<button class="btn btn-sm" onclick="Properties.edit(\''+p.id+'\')">Edit</button>'
            + '<button class="btn btn-sm btn-danger" onclick="Properties.remove(\''+p.id+'\')">✕</button>'
            + '</div></div>');
        });
        html.push('</div>');
      }
      el.innerHTML = html.join('');
    } catch(e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load properties</p></div>'; }
  },

  edit(id) {
    const p = id ? this._props.find(x=>x.id===id) : {};
    const opts = this._customers.map(c=>'<option value="'+c.id+'"'+(p.customerId===c.id?' selected':'')+'>'+esc(c.name)+'</option>').join('');
    const f = (label, key, val, ph='') => '<div class="form-group"><label class="form-label">'+label+'</label><input class="form-input" id="prop-'+key+'" value="'+esc(val||'')+'" placeholder="'+ph+'" /></div>';
    Modal.show('<div class="modal-title">'+(id?'Edit':'Add')+' Property</div>'
      + '<div class="form-group"><label class="form-label">Customer</label><select class="form-input" id="prop-customerId"><option value="">— Select customer —</option>'+opts+'</select></div>'
      + f('Label','label',p.label,'e.g. Main house')
      + f('Address','address',p.address,'123 Oak St')
      + '<div class="form-row">'+propertyFields().map(pf=>f(esc(pf.label),pf.key,p[pf.key])).join('')+'</div>'
      + f('Gate code','gateCode',p.gateCode)
      + f('Alarm instructions','alarmInstructions',p.alarmInstructions)
      + f('Pet info','petInfo',p.petInfo,'Friendly dog in yard')
      + f('Access notes','accessNotes',p.accessNotes,'Key under planter')
      + '<div class="modal-actions"><button class="btn" onclick="Modal.close()">Cancel</button><button class="btn btn-green" onclick="Properties.save(\''+(id||'')+'\',this)">Save</button></div>');
  },

  async save(id, btn) {
    const g = (k) => (document.getElementById('prop-'+k)||{}).value || '';
    const body = { customerId:g('customerId'), label:g('label'), address:g('address'), gateCode:g('gateCode'), alarmInstructions:g('alarmInstructions'), petInfo:g('petInfo'), accessNotes:g('accessNotes') };
    // Keep values for attributes this vertical doesn't show (e.g. a property
    // created before a profile change) rather than blanking them on save.
    const prev = id ? (this._props.find(x=>x.id===id) || {}) : {};
    propertyFields().forEach(pf => { body[pf.key] = g(pf.key); });
    ['bedrooms','bathrooms','squareFootage','propertyType','stories'].forEach(k => { if (body[k] === undefined && prev[k]) body[k] = prev[k]; });
    if (id) body.id = id;
    if (!body.address) { toast('Address is required','error'); return; }
    disableBtn(btn);
    try { await db.properties.save(body); Modal.close(); toast('Property saved ✓'); this.render(); }
    catch(e) { enableBtn(btn); toast(e.message||'Could not save','error'); }
  },

  async remove(id) {
    if (!confirm('Delete this property?')) return;
    try { await db.properties.delete(id); toast('Property deleted'); this.render(); }
    catch(e) { toast(e.message||'Could not delete','error'); }
  },
};
