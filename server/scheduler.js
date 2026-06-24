const { master, getShopDb, shopHelpers, shopFromNumber, buildSms, twilioClient, TWILIO_DEFAULT_FROM } = require('./db');
const { generateDueRecurring } = require('./recurring');

// ── Scheduler: 24hr reminders + 21-day rebook nudges ─────────────────────────
async function runScheduler() {
  try {
    const shops = master.get('shops').value().filter(s => s.active);
    for (const shop of shops) {
      try {
        const db = getShopDb(shop.id);
        const s = db.get('settings').value()||{};

        // Compute dates in the shop's local timezone (default Mountain — company
        // HQ) so "tomorrow" doesn't skew across the UTC date boundary for
        // evening-local appointments. 'en-CA' formats as YYYY-MM-DD.
        const TZ = s.timezone || process.env.DEFAULT_TZ || 'America/Denver';
        const localDate = (offsetMs) => new Date(Date.now()+offsetMs).toLocaleDateString('en-CA', { timeZone: TZ });
        const todayStr = localDate(0);

        // ── Recurring job generation (cleaning/recurring contracts; no SMS needed) ──
        // Runs before the Twilio guard so jobs are spawned even for shops that
        // haven't configured SMS. Generated rows are ordinary appointments.
        try { generateDueRecurring(db, todayStr); } catch(e){}

        // ── SMS-gated automations below ──
        const fromNum = shopFromNumber(shop.id);
        if (!twilioClient || !fromNum) continue;  // skip shops without SMS configured

        // ── 24hr appointment reminders ──
        const tomorrow = localDate(24*3600000);
        const appts = db.get('appointments').value().filter(a=>a.date===tomorrow&&a.status==='confirmed');
        const sentIds = s.remindersSent||[];
        const toRemind = appts.filter(a=>!sentIds.includes(a.id)&&a.customerPhone);
        for (const appt of toRemind) {
          const phone = (appt.customerPhone||'').replace(/[^0-9]/g,'');
          if (phone.length<10) continue;
          const msg = buildSms('reminder', { name:(appt.customerName||'').split(' ')[0], shop:s.shopName, time:appt.time, barber:appt.barberName }, s);
          try { await twilioClient.messages.create({from:fromNum,to:'+1'+phone,body:msg}); sentIds.push(appt.id); } catch(e){}
        }
        // Prune to ids of appointments still today/future. Keeps the dedup list
        // bounded WITHOUT a flat .slice() cap that could evict an id and re-remind.
        const liveApptIds = new Set(db.get('appointments').value().filter(a=>(a.date||'')>=todayStr).map(a=>a.id));
        const prunedSent = sentIds.filter(id => liveApptIds.has(id));
        if (toRemind.length || prunedSent.length !== (s.remindersSent||[]).length) db.get('settings').assign({ remindersSent: prunedSent }).write();

        // ── Rebook nudges (interval set per shop, default 21 days) ──
        const rebookDays = Math.min(90, Math.max(7, s.rebookInterval || 21));
        const nudgeSentIds = s.nudgesSent||[];
        const cutoffDate = localDate(-rebookDays*24*3600000);
        // Find each customer's most recent completed appointment
        const allAppts = db.get('appointments').value().filter(a=>a.status==='done');
        const lastVisit = {};
        allAppts.forEach(a=>{ if(!lastVisit[a.customerId]||a.date>lastVisit[a.customerId].date) lastVisit[a.customerId]={date:a.date,name:a.customerName,phone:a.customerPhone}; });
        // Anyone whose last visit was rebookDays+ ago and hasn't been nudged yet
        const toNudge = Object.values(lastVisit).filter(v=>v.date<=cutoffDate&&v.phone);
        for (const v of toNudge) {
          const nudgeKey = v.phone+':'+v.date;
          if (nudgeSentIds.includes(nudgeKey)) continue;
          const phone = (v.phone||'').replace(/[^0-9]/g,'');
          if (phone.length<10) continue;
          const firstName = (v.name||'').split(' ')[0]||'there';
          const msg = buildSms('rebook', { name:firstName, shop:s.shopName }, s);
          try { await twilioClient.messages.create({from:fromNum,to:'+1'+phone,body:msg}); nudgeSentIds.push(nudgeKey); } catch(e){}
        }
        // Prune nudge keys (format "phone:YYYY-MM-DD") older than 180 days so the
        // list stays bounded and a stale key can't be evicted and re-nudge.
        const nudgeFloor = localDate(-180*24*3600000);
        const prunedNudges = nudgeSentIds.filter(k => (k.split(':')[1]||'') >= nudgeFloor);
        if (toNudge.length || prunedNudges.length !== (s.nudgesSent||[]).length) db.get('settings').assign({ nudgesSent: prunedNudges }).write();

      } catch(e) {}
    }
  } catch(e) { console.error('Scheduler error:', e.message); }
}
setInterval(runScheduler, 5*60*1000);

module.exports = { runScheduler };
