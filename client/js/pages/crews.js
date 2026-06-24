// ── Crews (cleaning module) ──────────────────────────────────────────────────
// A crew is a named team of staff members. Jobs are assigned to a crew; the
// dashboard reads crew assignments for utilization + revenue-per-cleaner.
const Crews = {
  _crews: [], _staff: [],

  async render() {
    const el = document.getElementById('page-crews'); if (!el) return;
    el.innerHTML = '<div class="card"><p style="color:var(--muted)">Loading…</p></div>';
    try {
      const [crews, staff] = await Promise.all([ db.crews.all(), db.barbers.all().catch(()=>[]) ]);
      this._crews = crews || [];
      this._staff = staff || [];
      const name = (id) => (this._staff.find(s=>s.id===id)||{}).name || '?';
      const html = [];
      html.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;"><div class="section-header" style="margin:0;">Crews</div><button class="btn btn-green btn-sm" onclick="Crews.edit()">+ Add Crew</button></div>');
      if (!this._crews.length) {
        html.push('<div class="card empty-state"><div class="empty-icon">👥</div><div class="empty-text">No crews yet. Group your cleaners into teams you can assign to jobs.</div></div>');
      } else {
        html.push('<div class="list-card">');
        this._crews.forEach(c => {
          const members = (c.memberIds||[]).map(name).join(', ') || 'No members yet';
          const dot = c.color ? '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:'+esc(c.color)+';margin-right:7px;"></span>' : '';
          html.push('<div class="list-row"><div class="list-main">'
            + '<div class="list-name">'+dot+esc(c.name)+'</div>'
            + '<div class="list-sub">'+esc(members)+'</div>'
            + '</div><div class="list-right" style="display:flex;gap:6px;">'
            + '<button class="btn btn-sm" onclick="Crews.edit(\''+c.id+'\')">Edit</button>'
            + '<button class="btn btn-sm btn-danger" onclick="Crews.remove(\''+c.id+'\')">✕</button>'
            + '</div></div>');
        });
        html.push('</div>');
      }
      el.innerHTML = html.join('');
    } catch(e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load crews</p></div>'; }
  },

  edit(id) {
    const c = id ? this._crews.find(x=>x.id===id) : { memberIds:[] };
    const checks = this._staff.length
      ? this._staff.map(s=>'<label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:14px;cursor:pointer;"><input type="checkbox" class="crew-member" value="'+s.id+'"'+((c.memberIds||[]).includes(s.id)?' checked':'')+' /> '+esc(s.name)+'</label>').join('')
      : '<div style="font-size:13px;color:var(--muted);">No staff yet — add team members in Settings, then assign them here.</div>';
    Modal.show('<div class="modal-title">'+(id?'Edit':'Add')+' Crew</div>'
      + '<div class="form-group"><label class="form-label">Crew name</label><input class="form-input" id="crew-name" value="'+esc(c.name||'')+'" placeholder="Crew A" /></div>'
      + '<div class="form-group"><label class="form-label">Color</label><input class="form-input" id="crew-color" type="color" value="'+esc(c.color||'#2563eb')+'" style="height:42px;padding:4px;" /></div>'
      + '<div class="form-group"><label class="form-label">Members</label>'+checks+'</div>'
      + '<div class="modal-actions"><button class="btn" onclick="Modal.close()">Cancel</button><button class="btn btn-green" onclick="Crews.save(\''+(id||'')+'\',this)">Save</button></div>');
  },

  async save(id, btn) {
    const name = (document.getElementById('crew-name')||{}).value || '';
    const color = (document.getElementById('crew-color')||{}).value || '';
    const memberIds = Array.from(document.querySelectorAll('.crew-member:checked')).map(x=>x.value);
    if (!name.trim()) { toast('Crew name is required','error'); return; }
    const body = { name:name.trim(), color, memberIds };
    if (id) body.id = id;
    disableBtn(btn);
    try { await db.crews.save(body); Modal.close(); toast('Crew saved ✓'); this.render(); }
    catch(e) { enableBtn(btn); toast(e.message||'Could not save','error'); }
  },

  async remove(id) {
    if (!confirm('Delete this crew?')) return;
    try { await db.crews.delete(id); toast('Crew deleted'); this.render(); }
    catch(e) { toast(e.message||'Could not delete','error'); }
  },
};
