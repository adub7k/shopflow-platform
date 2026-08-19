// ── Reviews ───────────────────────────────────────────────────────────────────
// In-app star reviews: collect via the public review link, manage here, and
// feature the best ones on the booking page.
const Reviews = {
  async render() {
    const el = document.getElementById('page-reviews'); if (!el) return;
    try {
      const [data, appts] = await Promise.all([ db.reviews.all(), db.appointments.all().catch(()=>[]) ]);
      const reviews = data.reviews || [];
      const st = data.stats || { count:0, avg:0, dist:[0,0,0,0,0] };
      const link = location.origin + '/review/' + (Auth.getShopSlug() || '');
      const html = [];

      // Summary
      html.push('<div class="card" style="text-align:center;padding:22px;">');
      if (st.count) {
        html.push('<div style="font-size:46px;font-weight:900;letter-spacing:-.04em;line-height:1;">'+st.avg.toFixed(1)+'</div>');
        html.push('<div style="color:#f6b900;font-size:20px;letter-spacing:3px;margin:6px 0;">'+Reviews._stars(Math.round(st.avg))+'</div>');
        html.push('<div style="font-size:13px;color:var(--muted);">'+st.count+' review'+(st.count!==1?'s':'')+'</div>');
        html.push('<div style="margin-top:16px;text-align:left;">');
        for (let s=5;s>=1;s--) { const n=st.dist[s-1]||0, pct=st.count?Math.round(n/st.count*100):0;
          html.push('<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px;"><span style="width:10px;color:var(--muted);">'+s+'</span><span style="color:#f6b900;">★</span><div style="flex:1;height:7px;background:var(--surface2);border-radius:4px;overflow:hidden;"><div style="height:100%;width:'+pct+'%;background:#f6b900;"></div></div><span style="width:22px;text-align:right;color:var(--muted);">'+n+'</span></div>');
        }
        html.push('</div>');
      } else {
        html.push('<div style="font-size:40px;margin-bottom:8px;">⭐</div><div style="font-weight:700;">No reviews yet</div><div style="font-size:13px;color:var(--muted);margin-top:4px;">Share your review link to start collecting feedback.</div>');
      }
      html.push('</div>');

      // Review link. The text requests below send the Google link when one is
      // set in Settings, so show that as the primary link and keep the in-app
      // rating page as the secondary (it's what feeds the stars on this page).
      const google = ((Shop.settings && Shop.settings.googleReviewLink) || '').trim();
      const primary = google || link;
      html.push('<div class="section-header">Your Review Link</div><div class="card">');
      html.push('<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">'
        + (google ? 'Your Google review link — this is what the text requests below send.'
                  : 'Send this to clients after their visit — they rate you in seconds.') + '</div>');
      html.push('<div style="display:flex;gap:8px;align-items:center;"><input class="form-input" id="rev-link" readonly value="'+esc(primary)+'" style="flex:1;font-size:12px;" onclick="this.select()" /><button class="btn btn-green" onclick="navigator.clipboard.writeText(\''+esc(primary)+'\');toast(\'Link copied ✓\')">Copy</button></div>');
      if (google) {
        html.push('<div style="font-size:12px;color:var(--faint);margin-top:10px;">In-app rating page (feeds the stars above): <span style="font-family:monospace;">'+esc(link)+'</span></div>');
      } else {
        html.push('<div style="font-size:12px;color:var(--faint);margin-top:10px;">Add your Google review link in Settings to send clients straight to Google instead.</div>');
      }
      html.push('</div>');

      // Ask recent clients (completed, has phone, not yet reviewed)
      const done = (appts||[]).filter(a=>a.status==='done' && a.customerPhone && !a.reviewId)
        .sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,6);
      this._recent = {}; done.forEach(a=>{ this._recent[a.id]=a; });   // so request() can build the text
      if (done.length) {
        html.push('<div class="section-header">Ask Recent Clients</div><div class="list-card">');
        done.forEach(a=>{
          const sent = !!a.reviewRequestedAt;
          html.push('<div class="list-row"><div class="list-main"><div class="list-name">'+esc(a.customerName||'Client')+'</div><div class="list-sub">'+esc(a.service||'')+' · '+fmtDateShort(a.date)+'</div></div><button class="btn btn-sm '+(sent?'':'btn-green')+'" onclick="Reviews.request(\''+a.id+'\',this)">'+(sent?'Sent ✓':'Text request')+'</button></div>');
        });
        html.push('</div>');
      }

      // All reviews
      if (reviews.length) {
        html.push('<div class="section-header">All Reviews</div>');
        reviews.forEach(r=>html.push(Reviews._card(r)));
      }

      el.innerHTML = html.join('');
    } catch(e) { el.innerHTML = '<div class="card"><p style="color:var(--muted)">Could not load reviews</p></div>'; }
  },

  _stars(n){ n=Math.max(0,Math.min(5,n)); return '★★★★★'.slice(0,n)+'☆☆☆☆☆'.slice(0,5-n); },

  _card(r){
    const date = fmtDateShort(r.createdAt ? r.createdAt.split('T')[0] : '');
    return '<div class="card" style="margin-bottom:8px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;">'
      +   '<div style="color:#f6b900;font-size:16px;letter-spacing:2px;">'+Reviews._stars(r.rating)+'</div>'
      +   (r.featured?'<span style="font-size:10px;font-weight:700;color:var(--green);background:var(--green-lt);padding:3px 9px;border-radius:20px;">★ Featured</span>':'')
      + '</div>'
      + (r.comment?'<div style="font-size:14px;margin:8px 0;line-height:1.5;">“'+esc(r.comment)+'”</div>':'<div style="height:6px;"></div>')
      + '<div style="font-size:12px;color:var(--muted);">'+esc(r.name||'Anonymous')+(r.service?' · '+esc(r.service):'')+(date?' · '+date:'')+'</div>'
      + '<div style="display:flex;gap:8px;margin-top:10px;">'
      +   '<button class="btn btn-sm" onclick="Reviews.feature(\''+r.id+'\')">'+(r.featured?'Unfeature':'Feature on booking page')+'</button>'
      +   '<button class="btn btn-sm btn-danger" onclick="Reviews.remove(\''+r.id+'\')">Delete</button>'
      + '</div></div>';
  },

  async feature(id){ try{ await db.reviews.feature(id); this.render(); }catch(e){ toast('Could not update','error'); } },
  async remove(id){ if(!confirm('Delete this review? This cannot be undone.'))return; try{ await db.reviews.remove(id); toast('Review deleted'); this.render(); }catch(e){ toast('Could not delete','error'); } },
  async request(id, btn){
    const a = (this._recent||{})[id];
    if(!a || !a.customerPhone){ toast('No phone number on file','warning'); return; }
    // Manual review request: open the owner's Messages prefilled from the review
    // template (no Twilio/A2P). The {link} points at this shop's review page tied to
    // the visit, so the rating lands back in-app. _smsTemplateBody resolves the
    // owner's own "Review request" template by name, so renaming or re-creating it
    // in Settings keeps this prompt correct.
    // {link} = the shop's Google review link (Settings → Google Review Link) —
    // same as the Messages composer, Tasks and the client profile. Without one
    // configured, fall back to the in-app rating page tied to this visit.
    const slug = (typeof Auth!=='undefined' && Auth.getShopSlug && Auth.getShopSlug()) || '';
    const google = ((Shop.settings && Shop.settings.googleReviewLink) || '').trim();
    const link = google || (location.origin + '/review/' + slug + (slug?('?a='+a.id):''));
    // A review text without the link is useless — append it if the template omits it.
    let tpl = _smsTemplateBody('review');
    if (!/\{link\}/.test(tpl)) tpl = (tpl.trim() + ' {link}').trim();
    const body = _smsFill(tpl, {
      first: (a.customerName||'there').split(' ')[0],
      name:  a.customerName || 'there',
      shop:  (Shop.settings && Shop.settings.shopName) || 'us',
      link,
    });
    _cpSms(a.customerPhone, body);
    // Persist the "requested" flag (mark-only — the server no longer texts).
    try{ await db.reviews.request(id); a.reviewRequestedAt=new Date().toISOString();
      if(btn){ btn.textContent='Sent ✓'; btn.classList.remove('btn-green'); } }
    catch(e){ /* deep link already opened; flag will catch up on next request */ }
  },
};
