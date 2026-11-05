// Call performance widget — shared by /call-performance.html and the
// "Call performance" tab in /sales.html.
//
//   CallPerf.mount(containerEl, { getOwnerId: () => ownerId | null, role })
//
// Reads /api/call-performance (HubSpot meetings carrying the call_* properties
// written by the n8n Sales Call Scoring workflow) and renders KPIs, leaderboard,
// radar per rep, weekly trend, intake coverage, next-step mix and recent calls.
// Scope toggle: "Whole team" (everyone can see every rep) or one rep
// (the viewer's own calls for sales reps, the selected rep for admins/managers).
(function () {
  const REP_COLORS = { '118972528': '#1565C0', '84179396': '#0DA88C', '90988586': '#ED9511', '30458491': '#5C42C2', '80532547': '#E07A5F' };
  const TEAM_COLOR = '#334155';
  const AXES = [
    { id: 'budget', label: 'Budget' }, { id: 'authority', label: 'Authority' }, { id: 'need', label: 'Need' },
    { id: 'timing', label: 'Timing' }, { id: 'next_step', label: 'Next step' }, { id: 'intake', label: 'Intake' }
  ];
  const OUTCOME_LABEL = { booked_on_call: 'Booked on call', attempted_on_call: 'Attempted on call', asked_only: 'Asked only', deferred_to_email: 'Deferred to email', none: 'No next step' };
  const OUTCOME_COLOR = { booked_on_call: '#0DA88C', attempted_on_call: '#1565C0', asked_only: '#ED9511', deferred_to_email: '#E07A5F', none: '#94A3B8' };
  const TYPE_LABEL = { discovery: 'Discovery', demo: 'Demo', follow_up: 'Follow-up', check_in: 'Check-in', other: 'Other' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = v => (v === null || v === undefined) ? '–' : Math.round(v);
  const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–';
  const colorFor = id => REP_COLORS[id] || '#94A3B8';
  const scoreColor = v => v === null ? '#D5D9E2' : v >= 70 ? '#0DA88C' : v >= 40 ? '#ED9511' : '#E07A5F';

  const CSS = `
  .cp .cp-controls { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:14px; font-size:12px; color:#5F5E5A; }
  .cp .cp-controls select { font:inherit; padding:4px 8px; border:0.5px solid rgba(0,0,0,0.15); border-radius:6px; background:#fff; }
  .cp .seg { display:inline-flex; border:0.5px solid rgba(0,0,0,0.15); border-radius:6px; overflow:hidden; }
  .cp .seg button { border:none; background:#fff; padding:4px 10px; font:inherit; font-size:12px; cursor:pointer; color:#5F5E5A; border-radius:0; box-shadow:none; }
  .cp .seg button.on { background:#E3F2FB; color:#0F3B91; font-weight:600; }
  .cp .kpi-row { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px; }
  .cp .kpi { background:#F7F7F4; border-radius:10px; padding:14px 16px; }
  .cp .kpi .kpi-label { font-size:12px; color:#5F5E5A; }
  .cp .kpi .kpi-value { font-size:26px; font-weight:500; margin-top:4px; }
  .cp .kpi .kpi-sub { font-size:11.5px; color:#888780; margin-top:2px; }
  .cp .grid-2 { display:grid; grid-template-columns:1.1fr 1fr; gap:14px; margin-bottom:16px; }
  .cp .section { margin-bottom:16px; }
  .cp .panel-title { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .cp .panel-title .hint { font-weight:400; color:#888780; font-size:11.5px; }
  .cp table { width:100%; border-collapse:collapse; font-size:13px; }
  .cp th { text-align:left; padding:8px 6px; color:#5F5E5A; font-weight:500; font-size:12px; border-bottom:0.5px solid rgba(0,0,0,0.08); }
  .cp td { padding:8px 6px; border-bottom:0.5px solid rgba(0,0,0,0.06); vertical-align:middle; }
  .cp td.num, .cp th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .cp tr.team-row td { font-weight:600; }
  .cp .dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:-1px; }
  .cp .scorebar { display:inline-flex; align-items:center; gap:8px; min-width:150px; }
  .cp .scorebar .track { display:block; flex:1; height:8px; background:rgba(21,101,192,.08); border-radius:4px; overflow:hidden; }
  .cp .scorebar .fill { display:block; height:100%; border-radius:4px; }
  .cp .badge { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:500; white-space:nowrap; }
  .cp .badge.booked_on_call { background:#E1F5EE; color:#0F6E56; }
  .cp .badge.attempted_on_call { background:#E3F2FB; color:#0F3B91; }
  .cp .badge.asked_only { background:#FAEEDA; color:#854F0B; }
  .cp .badge.deferred_to_email, .cp .badge.none { background:#FCEBEB; color:#791F1F; }
  .cp .badge.type { background:#F1EFE8; color:#444441; }
  .cp .bant-dots { display:inline-flex; gap:4px; }
  .cp .bant-dots span { width:14px; height:14px; border-radius:4px; font-size:9px; display:inline-flex; align-items:center; justify-content:center; font-weight:700; color:#fff; }
  .cp .bant-dots .asked { background:#0DA88C; } .cp .bant-dots .partially { background:#ED9511; } .cp .bant-dots .not_asked { background:#D5D9E2; color:#64748B; }
  .cp .radar-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; }
  .cp .radar-card { background:#F7F7F4; border-radius:10px; padding:10px 10px 6px; text-align:center; }
  .cp .radar-card .name { font-size:12.5px; font-weight:600; margin-bottom:2px; }
  .cp .radar-card .sub { font-size:11px; color:#888780; margin-bottom:4px; }
  .cp .legend { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:12px; color:#5F5E5A; margin:6px 0 2px; }
  .cp .legend .item { display:inline-flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
  .cp .legend .item.off { opacity:.35; }
  .cp .legend .swatch { width:18px; height:3px; border-radius:2px; display:inline-block; }
  .cp .chips { display:flex; flex-wrap:wrap; gap:4px; }
  .cp .chip { font-size:10.5px; padding:1px 7px; border-radius:8px; background:#E3F2FB; color:#0F3B91; }
  .cp .chip.missing { background:#F1EFE8; color:#888780; text-decoration:line-through; }
  .cp .notes { font-size:12px; color:#444; white-space:pre-wrap; line-height:1.5; background:#F7F7F4; border-radius:8px; padding:10px 12px; margin:4px 0 8px; }
  .cp .loading { text-align:center; padding:40px; color:#888780; font-size:13px; }
  .cp .error { background:#FCEBEB; color:#791F1F; padding:10px 14px; border-radius:8px; margin-bottom:12px; font-size:13px; }
  .cp svg text { font-family:inherit; }
  .cp-tip { position:fixed; pointer-events:none; background:#1A1A1A; color:#fff; font-size:11.5px; padding:8px 10px; border-radius:8px; z-index:60; display:none; max-width:280px; line-height:1.45; }
  @media (max-width: 900px) { .cp .kpi-row { grid-template-columns:repeat(2,1fr); } .cp .grid-2 { grid-template-columns:1fr; } }`;

  function injectCss() {
    if (document.getElementById('cp-css')) return;
    const s = document.createElement('style'); s.id = 'cp-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function tipEl() {
    let t = document.getElementById('cp-tip');
    if (!t) { t = document.createElement('div'); t.id = 'cp-tip'; t.className = 'cp-tip'; document.body.appendChild(t); }
    return t;
  }
  function showTip(html, x, y) { const t = tipEl(); t.innerHTML = html; t.style.display = 'block'; const w = t.offsetWidth, h = t.offsetHeight; t.style.left = Math.min(x + 14, window.innerWidth - w - 10) + 'px'; t.style.top = Math.max(8, y - h - 12) + 'px'; }
  function hideTip() { tipEl().style.display = 'none'; }

  function mount(root, opts = {}) {
    injectCss();
    root.classList.add('cp');
    const role = opts.role || 'sales';
    const isRep = role === 'sales';
    const state = { days: '90', type: 'sales', scope: isRep ? 'rep' : 'team', metric: 'overall', hidden: new Set() };
    let data = null;

    root.innerHTML = `
      <div class="cp-controls">
        <div class="seg" data-ctl="scope">
          <button data-scope="rep">${isRep ? 'My calls' : 'Selected rep'}</button>
          <button data-scope="team">Whole team</button>
        </div>
        <label>Period
          <select data-ctl="days">
            <option value="30">Last 30 days</option>
            <option value="90" selected>Last 90 days</option>
            <option value="180">Last 6 months</option>
            <option value="365">Last 12 months</option>
            <option value="all">All time</option>
          </select>
        </label>
        <div class="seg" data-ctl="type">
          <button data-type="sales" class="on" title="Discovery, demo and follow-up calls">Sales calls</button>
          <button data-type="all" title="Includes check-ins and other call types">All calls</button>
        </div>
        <button class="refresh-btn" data-ctl="refresh" style="padding:4px 10px;font-size:12px">Refresh</button>
      </div>
      <div data-ctl="body"><div class="loading">Loading call scores from HubSpot…</div></div>`;
    const body = root.querySelector('[data-ctl="body"]');
    const syncSeg = (ctl, attr, val) => root.querySelectorAll(`[data-ctl="${ctl}"] button`).forEach(b => b.classList.toggle('on', b.dataset[attr] === val));
    syncSeg('scope', 'scope', state.scope);

    root.querySelector('[data-ctl="scope"]').addEventListener('click', e => { const b = e.target.closest('button[data-scope]'); if (!b) return; state.scope = b.dataset.scope; syncSeg('scope', 'scope', state.scope); render(); });
    root.querySelector('[data-ctl="type"]').addEventListener('click', e => { const b = e.target.closest('button[data-type]'); if (!b) return; state.type = b.dataset.type; syncSeg('type', 'type', state.type); load(); });
    root.querySelector('[data-ctl="days"]').addEventListener('change', e => { state.days = e.target.value; load(); });
    root.querySelector('[data-ctl="refresh"]').addEventListener('click', () => load(true));
    window.addEventListener('resize', () => { if (data && root.isConnected) drawTrend(); });

    async function load(fresh) {
      body.innerHTML = '<div class="loading">Loading call scores from HubSpot…</div>';
      try {
        const r = await fetch(`/api/call-performance?days=${state.days}&type=${state.type}${fresh ? '&fresh=' + Date.now() : ''}`);
        if (r.status === 401) { location.href = '/login.html'; return; }
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.detail || j.error || ('HTTP ' + r.status)); }
        data = await r.json();
        render();
      } catch (e) {
        body.innerHTML = `<div class="error">Could not load call performance: ${esc(e.message)}</div>`;
      }
    }

    function focusRep() {
      if (state.scope !== 'rep') return null;
      const id = String((opts.getOwnerId && opts.getOwnerId()) || data.my_owner_id || '');
      return id || null;
    }

    function render() {
      const d = data;
      if (!d.team.calls) {
        body.innerHTML = `<div class="loading">No scored calls in this period yet (${d.totals.scored_in_hubspot} scored meetings in HubSpot overall). Calls are scored automatically after each Zoom transcript lands in Confluence.</div>`;
        return;
      }
      const rid = focusRep();
      if (state.scope === 'rep' && !rid) { body.innerHTML = '<div class="loading">Pick a rep in the selector above, or switch to Whole team.</div>'; return; }
      const rep = rid ? d.reps.find(r => r.id === rid) : null;
      if (rid && !rep) { body.innerHTML = `<div class="loading">No scored calls for ${esc(d.rep_names[rid] || 'this rep')} in this period. Switch to Whole team to see everyone.</div>`; return; }
      const focus = rep || d.team;
      const focusName = rep ? rep.name : 'Team';
      const top = d.reps[0];
      const reps = rep ? [rep] : d.reps;
      const recent = rep ? d.recent.filter(c => c.rep_id === rid) : d.recent;

      body.innerHTML = `
        <div class="kpi-row">
          <div class="kpi"><div class="kpi-label">Calls scored</div><div class="kpi-value">${focus.calls}</div><div class="kpi-sub">${rep ? esc(rep.name) : d.reps.length + ' reps'} · ${state.type === 'sales' ? 'discovery, demo, follow-up' : 'all call types'}</div></div>
          <div class="kpi"><div class="kpi-label">${rep ? 'Score' : 'Team score'}</div><div class="kpi-value">${fmt(focus.overall)}<span style="font-size:13px;color:#888780"> /100</span></div><div class="kpi-sub">BANT ${fmt(focus.bant)} · Next step ${fmt(focus.next_step)} · Intake ${fmt(focus.intake)}${rep ? ' · team ' + fmt(d.team.overall) : ''}</div></div>
          <div class="kpi"><div class="kpi-label">Next meeting booked on the call</div><div class="kpi-value">${fmt(focus.booked_on_call_rate)}%</div><div class="kpi-sub">${focus.outcomes.attempted_on_call || 0} attempted · ${focus.outcomes.deferred_to_email || 0} deferred to email</div></div>
          ${rep
            ? `<div class="kpi"><div class="kpi-label">Rank on the team</div><div class="kpi-value">#${d.reps.findIndex(r => r.id === rid) + 1}<span style="font-size:13px;color:#888780"> of ${d.reps.length}</span></div><div class="kpi-sub">by average score, this period</div></div>`
            : `<div class="kpi"><div class="kpi-label">Leading the board</div><div class="kpi-value" style="font-size:20px;"><span class="dot" style="background:${colorFor(top.id)}"></span>${esc(top.name)}</div><div class="kpi-sub">${fmt(top.overall)} avg over ${top.calls} call${top.calls === 1 ? '' : 's'}</div></div>`}
        </div>

        <div class="section panel">
          <div class="panel-title"><span>Leaderboard</span><span class="hint">Average per scored call · 0-100</span></div>
          ${leaderboardTable(d, rid)}
        </div>

        <div class="section panel">
          <div class="panel-title"><span>Skill profile${rep ? '' : ' per rep'}</span><span class="hint">Grey shape = team average</span></div>
          <div class="radar-grid">${reps.map(r => radarCard(r, d.team)).join('')}</div>
        </div>

        <div class="section panel">
          <div class="panel-title">
            <span>Trend by week</span>
            <div class="seg" data-ctl="metric">
              ${['overall', 'bant', 'next_step', 'intake'].map(m => `<button data-metric="${m}" class="${state.metric === m ? 'on' : ''}">${{ overall: 'Overall', bant: 'BANT', next_step: 'Next step', intake: 'Intake' }[m]}</button>`).join('')}
            </div>
          </div>
          <div class="legend" data-ctl="legend">
            ${reps.map(r => `<span class="item ${state.hidden.has(r.id) ? 'off' : ''}" data-rep="${r.id}"><span class="swatch" style="background:${colorFor(r.id)}"></span>${esc(r.name)}</span>`).join('')}
            <span class="item" data-rep="team"><span class="swatch" style="background:${TEAM_COLOR};height:4px"></span>Team</span>
          </div>
          <div data-ctl="trend"></div>
        </div>

        <div class="grid-2">
          <div class="panel">
            <div class="panel-title"><span>Intake basics covered</span><span class="hint">Share of ${rep ? esc(rep.name.split(' ')[0]) + "'s" : 'all'} calls where the topic came up</span></div>
            ${intakeBars(d, focus)}
          </div>
          <div class="panel">
            <div class="panel-title"><span>How the next step was handled</span><span class="hint">${esc(focusName)}, this period</span></div>
            ${outcomeBars(d, focus, !rep)}
          </div>
        </div>

        <div class="section panel">
          <div class="panel-title"><span>Recent scored calls</span><span class="hint">B A N T = budget, authority, need, timing · click a row for coaching notes</span></div>
          ${recentTable(d, recent)}
        </div>`;

      drawTrend();
      body.querySelector('[data-ctl="metric"]').addEventListener('click', e => {
        const b = e.target.closest('button[data-metric]'); if (!b) return;
        state.metric = b.dataset.metric;
        body.querySelectorAll('[data-ctl="metric"] button').forEach(x => x.classList.toggle('on', x === b));
        drawTrend();
      });
      body.querySelector('[data-ctl="legend"]').addEventListener('click', e => {
        const it = e.target.closest('.item[data-rep]'); if (!it || it.dataset.rep === 'team') return;
        const id = it.dataset.rep;
        if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
        it.classList.toggle('off', state.hidden.has(id));
        drawTrend();
      });
      body.querySelectorAll('tr[data-call]').forEach(tr => tr.addEventListener('click', () => {
        const n = tr.nextElementSibling; if (n && n.classList.contains('notes-row')) n.style.display = n.style.display === 'none' ? '' : 'none';
      }));
    }

    function bar(v, color) {
      return `<span class="scorebar"><span class="track"><span class="fill" style="width:${v === null ? 0 : Math.max(2, v)}%;background:${color}"></span></span><span class="num" style="min-width:26px;text-align:right">${fmt(v)}</span></span>`;
    }

    function leaderboardTable(d, rid) {
      return `<table>
        <thead><tr><th>#</th><th>Rep</th><th class="num">Calls</th><th>Overall</th><th class="num">BANT</th><th class="num">Next step</th><th class="num">Intake</th><th class="num">Booked on call</th></tr></thead>
        <tbody>${d.reps.map((r, i) => `<tr style="${rid === r.id ? 'background:rgba(21,101,192,.06)' : (rid ? 'opacity:.75' : '')}">
          <td class="num" style="color:#888780">${i + 1}</td>
          <td><span class="dot" style="background:${colorFor(r.id)}"></span><strong>${esc(r.name)}</strong></td>
          <td class="num">${r.calls}</td>
          <td>${bar(r.overall, colorFor(r.id))}</td>
          <td class="num">${fmt(r.bant)}</td>
          <td class="num">${fmt(r.next_step)}</td>
          <td class="num">${fmt(r.intake)}</td>
          <td class="num">${fmt(r.booked_on_call_rate)}%</td>
        </tr>`).join('')}
        <tr class="team-row" style="color:#5F5E5A"><td></td><td>Team</td><td class="num">${d.team.calls}</td><td>${bar(d.team.overall, TEAM_COLOR)}</td><td class="num">${fmt(d.team.bant)}</td><td class="num">${fmt(d.team.next_step)}</td><td class="num">${fmt(d.team.intake)}</td><td class="num">${fmt(d.team.booked_on_call_rate)}%</td></tr>
        </tbody></table>`;
    }

    function radarCard(rep, team) {
      const size = 200, cx = 130, cy = 100, R = 62, W = 260;
      const n = AXES.length;
      const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; const rr = R * (Math.max(0, Math.min(100, v || 0)) / 100); return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; };
      const poly = axes => AXES.map((ax, i) => pt(i, axes[ax.id]).join(',')).join(' ');
      const rings = [25, 50, 75, 100].map(p => `<polygon points="${AXES.map((_, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; const rr = R * p / 100; return (cx + rr * Math.cos(a)) + ',' + (cy + rr * Math.sin(a)); }).join(' ')}" fill="none" stroke="rgba(100,116,139,.18)" stroke-width="1"/>`).join('');
      const spokes = AXES.map((_, i) => { const [x, y] = pt(i, 100); return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(100,116,139,.18)"/>`; }).join('');
      const labels = AXES.map((ax, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; const lx = cx + (R + 18) * Math.cos(a), ly = cy + (R + 18) * Math.sin(a); const anchor = Math.abs(Math.cos(a)) < 0.2 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end'); return `<text x="${lx}" y="${ly + 4}" font-size="10" fill="#64748B" text-anchor="${anchor}">${ax.label}</text>`; }).join('');
      const col = colorFor(rep.id);
      const dots = AXES.map((ax, i) => { const [x, y] = pt(i, rep.axes[ax.id]); return `<circle cx="${x}" cy="${y}" r="3.5" fill="${col}" stroke="#fff" stroke-width="1.5"><title>${ax.label}: ${fmt(rep.axes[ax.id])} (team ${fmt(team.axes[ax.id])})</title></circle>`; }).join('');
      return `<div class="radar-card">
        <div class="name"><span class="dot" style="background:${col}"></span>${esc(rep.name)}</div>
        <div class="sub">${rep.calls} call${rep.calls === 1 ? '' : 's'} · overall ${fmt(rep.overall)}</div>
        <svg viewBox="0 0 ${W} ${size}" width="100%" style="max-width:260px" role="img" aria-label="Skill radar for ${esc(rep.name)}">
          ${rings}${spokes}
          <polygon points="${poly(team.axes)}" fill="rgba(51,65,85,.10)" stroke="rgba(51,65,85,.45)" stroke-width="1.5" stroke-dasharray="3 3"/>
          <polygon points="${poly(rep.axes)}" fill="${col}22" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
          ${dots}${labels}
        </svg>
      </div>`;
    }

    function drawTrend() {
      const d = data, host = body.querySelector('[data-ctl="trend"]');
      if (!host) return;
      const rid = focusRep();
      const weeks = d.trend;
      if (!weeks.length) { host.innerHTML = '<div class="loading">No weekly data.</div>'; return; }
      const W = Math.max(640, host.clientWidth || 900), H = 300, padL = 40, padR = 110, padT = 14, padB = 40;
      const x = i => padL + (weeks.length === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (weeks.length - 1));
      const y = v => padT + (H - padT - padB) * (1 - v / 100);
      const metric = state.metric;
      const series = [];
      for (const r of d.reps) {
        if (rid && r.id !== rid) continue;
        if (state.hidden.has(r.id)) continue;
        series.push({ id: r.id, name: r.name, color: colorFor(r.id), width: 2, dash: '', pts: weeks.map((w, i) => ({ i, v: w.reps[r.id] ? w.reps[r.id][metric] : null, n: w.reps[r.id] ? w.reps[r.id].calls : 0 })) });
      }
      series.push({ id: 'team', name: 'Team', color: TEAM_COLOR, width: 3, dash: metric === 'overall' ? '' : '6 4', pts: weeks.map((w, i) => {
        if (metric === 'overall') return { i, v: w.team, n: w.team_calls };
        const vals = Object.values(w.reps).filter(v => v[metric] !== null); const n = vals.reduce((a, b) => a + b.calls, 0);
        return { i, v: n ? Math.round(vals.reduce((a, b) => a + b[metric] * b.calls, 0) / n * 10) / 10 : null, n };
      }) });
      const grid = [0, 25, 50, 75, 100].map(v => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(100,116,139,.15)"/><text x="${padL - 6}" y="${y(v) + 4}" font-size="10" fill="#94A3B8" text-anchor="end">${v}</text>`).join('');
      const step = Math.ceil(weeks.length / 10);
      const xl = weeks.map((w, i) => i % step === 0 || i === weeks.length - 1 ? `<text x="${x(i)}" y="${H - padB + 16}" font-size="10" fill="#94A3B8" text-anchor="middle">${new Date(w.week + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>` : '').join('');
      const paths = series.map(s => {
        const segs = []; let cur = [];
        for (const p of s.pts) { if (p.v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p); }
        if (cur.length) segs.push(cur);
        const dPath = segs.map(seg => seg.map((p, k) => (k ? 'L' : 'M') + x(p.i) + ' ' + y(p.v)).join(' ')).join(' ');
        const singles = segs.filter(seg => seg.length === 1).map(seg => `<circle cx="${x(seg[0].i)}" cy="${y(seg[0].v)}" r="4" fill="${s.color}"/>`).join('');
        const last = [...s.pts].reverse().find(p => p.v !== null);
        const label = last ? `<text x="${x(last.i) + 6}" y="${y(last.v) + 4}" font-size="10.5" fill="#334155" font-weight="600">${esc(s.name)}</text>` : '';
        return `<path d="${dPath}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-dasharray="${s.dash}" stroke-linejoin="round" stroke-linecap="round" opacity="${s.id === 'team' ? 0.9 : 0.95}"/>${singles}${label}`;
      }).join('');
      const bw = (W - padL - padR) / Math.max(1, weeks.length - 1);
      const hover = weeks.map((w, i) => `<rect data-i="${i}" x="${x(i) - bw / 2}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"/>`).join('');
      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block">
        ${grid}<line data-xh x1="0" x2="0" y1="${padT}" y2="${H - padB}" stroke="#94A3B8" stroke-dasharray="3 3" style="display:none"/>
        ${paths}${xl}${hover}
      </svg>`;
      const svg = host.querySelector('svg'), xh = svg.querySelector('[data-xh]');
      svg.querySelectorAll('rect[data-i]').forEach(rc => {
        rc.addEventListener('mousemove', e => {
          const i = +rc.dataset.i; xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.style.display = '';
          const rows = series.map(s => { const p = s.pts[i]; return p.v === null ? '' : `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};margin-right:6px"></span>${esc(s.name)}: <b>${fmt(p.v)}</b> <span style="opacity:.7">(${p.n} call${p.n === 1 ? '' : 's'})</span></div>`; }).join('');
          showTip(`<div style="font-weight:600;margin-bottom:4px">Week of ${new Date(weeks[i].week + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</div>${rows}`, e.clientX, e.clientY);
        });
        rc.addEventListener('mouseleave', () => { xh.style.display = 'none'; hideTip(); });
      });
    }

    function intakeBars(d, focus) {
      return `<table><tbody>${d.intake_items.map(it => `<tr><td style="width:46%">${esc(it.label)}</td><td>${bar(focus.intake_coverage[it.id], '#1565C0')}<span style="color:#888780;font-size:11px">%</span></td></tr>`).join('')}</tbody></table>`;
    }

    function outcomeBars(d, focus, showPerRep) {
      const total = focus.calls || 1;
      const order = ['booked_on_call', 'attempted_on_call', 'asked_only', 'deferred_to_email', 'none'];
      return `<table><tbody>${order.map(o => { const n = focus.outcomes[o] || 0; return `<tr><td style="width:46%">${OUTCOME_LABEL[o]}</td><td>${bar(Math.round(n / total * 100), OUTCOME_COLOR[o])}<span style="color:#888780;font-size:11px">% · ${n}</span></td></tr>`; }).join('')}</tbody></table>
        ${showPerRep ? `<div class="panel-sub" style="margin-top:8px">Per rep: ${d.reps.map(r => `<span class="dot" style="background:${colorFor(r.id)}"></span>${esc(r.name.split(' ')[0])} ${fmt(r.booked_on_call_rate)}%`).join(' · ')} booked on call</div>` : ''}`;
    }

    function recentTable(d, recent) {
      const items = d.intake_items;
      if (!recent.length) return '<div class="loading">No scored calls.</div>';
      return `<table>
        <thead><tr><th>Date</th><th>Rep</th><th>Call</th><th>Type</th><th class="num">Overall</th><th>B A N T</th><th>Next step</th><th class="num">Intake</th></tr></thead>
        <tbody>${recent.map(c => `<tr data-call="${c.id}" style="cursor:pointer">
          <td style="white-space:nowrap">${fmtDate(c.date)}</td>
          <td><span class="dot" style="background:${colorFor(c.rep_id)}"></span>${esc(c.rep.split(' ')[0])}</td>
          <td><a href="${esc(c.hubspot_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(c.title)}</a></td>
          <td><span class="badge type">${TYPE_LABEL[c.call_type] || c.call_type}</span></td>
          <td class="num"><b style="color:${scoreColor(c.overall)}">${fmt(c.overall)}</b></td>
          <td><span class="bant-dots">${['budget', 'authority', 'need', 'timing'].map(k => `<span class="${c.bant_items[k] || 'not_asked'}" title="${k}: ${c.bant_items[k] || 'not asked'}">${k[0].toUpperCase()}</span>`).join('')}</span></td>
          <td><span class="badge ${c.outcome}">${OUTCOME_LABEL[c.outcome] || c.outcome}</span></td>
          <td class="num">${c.intake_covered.length}/${items.length}</td>
        </tr>
        <tr class="notes-row" style="display:none"><td colspan="8">
          <div class="chips" style="margin:4px 0 6px">${items.map(it => `<span class="chip ${c.intake_covered.includes(it.id) ? '' : 'missing'}">${esc(it.label)}</span>`).join('')}</div>
          <div class="notes">${esc(c.coaching_notes || 'No coaching notes.')}</div>
          ${c.transcript_url ? `<a href="${esc(c.transcript_url)}" target="_blank" rel="noopener">Open transcript in Confluence</a>` : ''}
        </td></tr>`).join('')}</tbody></table>`;
    }

    load();
    return { reload: () => load(), rerender: () => { if (data) render(); } };
  }

  window.CallPerf = { mount };
})();
