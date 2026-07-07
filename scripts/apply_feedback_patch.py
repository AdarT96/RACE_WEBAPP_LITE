from pathlib import Path


def patch_demo(path: Path):
    text = path.read_text(encoding="utf-8")
    marker = "// ── חשיפה לגלובל ──────────────────────────────────────"
    if "PATCH_FEEDBACK_GROUPS_DEMO" in text:
        return
    if marker not in text:
        raise RuntimeError("demo marker not found")

    patch = r'''
// PATCH_FEEDBACK_GROUPS_DEMO
const GROUP_COUNT = 8;
const PARTICIPANTS_PER_GROUP = 20;
let activeGroup = '01';
let raceRoundPlaces = {};

function ensureGroupSelector() {
  if (currentRole === 'admin') return;
  const navActions = document.querySelector('.navbar-actions');
  if (!navActions) return;
  let wrap = document.getElementById('group-selector-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'group-selector-wrap';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';
    wrap.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">קבוצה:</span><select id="group-select" class="form-select" style="width:92px;padding:6px 10px"></select>';
    const badge = document.getElementById('role-badge');
    if (badge && badge.parentNode === navActions) navActions.insertBefore(wrap, badge);
    else navActions.prepend(wrap);
    const sel = document.getElementById('group-select');
    sel.addEventListener('change', (e) => setActiveGroup(e.target.value));
  }
  const sel = document.getElementById('group-select');
  if (sel && sel.options.length === 0) {
    for (let i = 1; i <= GROUP_COUNT; i++) {
      const v = String(i).padStart(2, '0');
      const o = document.createElement('option');
      o.value = v;
      o.textContent = 'קבוצה ' + v;
      sel.appendChild(o);
    }
  }
  if (sel) sel.value = activeGroup;
}

function buildMockGroupPool(groupId) {
  const pool = [];
  for (let i = 1; i <= PARTICIPANTS_PER_GROUP; i++) {
    const participantId = String(i).padStart(4, '0');
    pool.push({
      epc: `E2003412${groupId}${participantId}`,
      teamId: groupId,
      participantId,
      rssi: -42 - Math.floor(Math.random() * 30),
      antenna: 1 + Math.floor(Math.random() * 8)
    });
  }
  return pool;
}

function getVisibleLeaderboard() {
  return leaderboard
    .filter(r => r.teamId === activeGroup)
    .slice()
    .sort((a, b) => raceMode === 1 ? (b.laps - a.laps || a.lastMs - b.lastMs) : a.firstMs - b.firstMs);
}

function setActiveGroup(groupId) {
  activeGroup = groupId;
  selectedEpc = null;
  const info = document.getElementById('selected-tag-info');
  if (info) info.textContent = `קבוצה פעילה: ${groupId}. לא נבחר משתתף.`;
  updateLeaderboard();
  updateStatCards();
}

const _enterAsOrig = enterAs;
enterAs = function(role) {
  _enterAsOrig(role);
  ensureGroupSelector();
  if (role !== 'admin') setActiveGroup(activeGroup);
};

const _resetOrig = resetToLogin;
resetToLogin = function() {
  _resetOrig();
  activeGroup = '01';
};

scheduleTagArrivals = function() {
  if (!scanning) return;
  const pool = buildMockGroupPool(activeGroup).sort(() => Math.random() - 0.5).slice(0, 12);
  const baseDelay = raceMode === 1 ? 1500 : 1200;
  pool.forEach((tag, i) => {
    const delay = baseDelay * (i + 1) * (0.8 + Math.random() * 0.6);
    tagTimer = setTimeout(() => {
      if (!scanning) return;
      const now = Date.now() - startTime;
      if (raceMode === 0) {
        const exists = leaderboard.find(t => t.epc === tag.epc);
        if (!exists) leaderboard.push({ ...tag, firstMs: now, lastMs: now, laps: 1, comments: [] });
      } else {
        const entry = leaderboard.find(t => t.epc === tag.epc);
        if (entry) { entry.laps++; entry.lastMs = now; }
        else leaderboard.push({ ...tag, firstMs: now, lastMs: now, laps: 1, comments: [] });
      }
      updateLeaderboard();
      updateStatCards();
    }, delay);
  });
};

initAntennaButtons = function() {
  if (!Array.isArray(antennaState) || antennaState.length < 8) {
    antennaState = Array.from({ length: 8 }, (_, i) => antennaState?.[i] ?? (i < 4));
  }
  const c = document.getElementById('ant-buttons');
  if (!c) return;
  c.innerHTML = '';
  antennaState.forEach((on, i) => {
    const btn = document.createElement('button');
    btn.className = 'ant-btn' + (on ? ' on' : '');
    btn.textContent = 'ANT ' + (i + 1);
    btn.onclick = () => {
      antennaState[i] = !antennaState[i];
      btn.className = 'ant-btn' + (antennaState[i] ? ' on' : '');
      showToast(`ANT ${i + 1} ${antennaState[i] ? 'מופעלת' : 'מכובה'}`, 'info');
    };
    c.appendChild(btn);
  });
};

updateStatCards = function() {
  const st = scanning ? '🟢 סורק' : '🔴 עצור';
  const md = raceMode === 1 ? 'הקפות' : 'הגעה';
  const visible = getVisibleLeaderboard();
  ['op-round','ev-round'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '#' + round; });
  ['op-status','ev-status'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = st; });
  ['op-tags','ev-tags'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = visible.length; });
  const ml = document.getElementById('op-mode-label'); if (ml) ml.textContent = md;
};

updateLeaderboard = function() {
  const noData = document.getElementById('lb-no-data');
  const table = document.getElementById('lb-table');
  const tbody = document.getElementById('lb-body');
  const colHead = document.getElementById('lb-col-score');
  if (!tbody) return;
  const rows = getVisibleLeaderboard();
  if (rows.length === 0) {
    noData.style.display = '';
    table.style.display = 'none';
    noData.textContent = `אין נתונים לקבוצה ${activeGroup} כרגע.`;
    return;
  }
  noData.style.display = 'none';
  table.style.display = '';
  const hasLaps = raceMode === 1;
  if (colHead) colHead.textContent = hasLaps ? 'הקפות' : 'זמן ראשון';
  tbody.innerHTML = '';
  rows.forEach((r, idx) => {
    const place = idx + 1;
    const tr = document.createElement('tr');
    tr.className = place <= 3 ? `place-${place}` : '';
    const timeStr = hasLaps
      ? `<span class="laps-badge">${r.laps} הקפות</span>`
      : `<code style="font-size:12px; direction:ltr; display:inline-block">${fmtTime(r.firstMs)}</code>`;
    const comments = (r.comments || []).map(c => `<span class="tag-pill" style="font-size:11px;padding:3px 8px">${c}</span>`).join('');
    tr.innerHTML = `
      <td><span class="place-badge">${place}</span></td>
      <td><strong>${r.teamId}</strong></td>
      <td><div>${r.participantId}</div><div class="epc-raw">${r.epc}</div></td>
      <td>${timeStr}</td>
      <td style="color:var(--text-muted)">${r.rssi} dBm</td>
      <td><div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">${comments}
      <button onclick="selectParticipant('${r.epc}','${r.participantId}')" style="font-size:11px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);border-radius:999px;cursor:pointer;color:var(--text-muted)">+</button>
      </div></td>`;
    tbody.appendChild(tr);
  });
};

const _stopOrig = stopRace;
stopRace = function() {
  const wasScanning = scanning;
  _stopOrig();
  if (wasScanning) {
    const rows = getVisibleLeaderboard();
    rows.forEach((r, i) => {
      const key = `${r.teamId}-${r.participantId}`;
      raceRoundPlaces[key] = raceRoundPlaces[key] || [];
      raceRoundPlaces[key].push({ round, place: i + 1 });
    });
  }
};

buildChart = function() {
  const ctx = document.getElementById('chart-canvas');
  if (!ctx) return;
  if (chartInst) { chartInst.destroy(); chartInst = null; }
  const rows = getVisibleLeaderboard();
  if (rows.length === 0) return;
  const selected = rows.find(r => r.epc === selectedEpc) || rows[0];
  const key = `${selected.teamId}-${selected.participantId}`;
  const points = raceRoundPlaces[key] || [];
  if (points.length === 0) {
    showToast(`אין היסטוריית סבבים למשתתף ${selected.participantId} עדיין`, 'info');
    return;
  }
  const labels = points.map(p => `סבב ${p.round}`);
  const values = points.map(p => p.place);
  chartInst = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: `מיקום משתתף ${selected.participantId}`,
        data: values,
        borderColor: '#60a5fa',
        backgroundColor: 'rgba(96,165,250,0.15)',
        fill: true,
        tension: 0.25,
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          reverse: true,
          beginAtZero: false,
          ticks: { precision: 0, color: '#94a3b8' },
          grid: { color: 'rgba(255,255,255,0.06)' }
        },
        x: { ticks: { color: '#94a3b8' }, grid: { display: false } }
      },
      plugins: { legend: { display: true } }
    }
  });
};
'''
    text = text.replace(marker, patch + "\n" + marker)
    path.write_text(text, encoding="utf-8")


def patch_app(path: Path):
    text = path.read_text(encoding="utf-8")
    marker = "window.showToast = (msg, type='info') => {"
    if "PATCH_FEEDBACK_GROUPS_APP" in text:
        return
    if marker not in text:
        raise RuntimeError("app marker not found")

    patch = r'''
  // PATCH_FEEDBACK_GROUPS_APP
  let activeGroup = localStorage.getItem('activeGroup') || '';
  let allRacesCache = [];

  function normalizeGroup(v) {
    const n = String(v || '').replace(/\D+/g, '');
    return n ? n.padStart(2, '0') : '';
  }

  function getFilteredRows(rows) {
    if (!activeGroup) return rows || [];
    return (rows || []).filter(r => normalizeGroup(r.teamId) === activeGroup);
  }

  function ensureGroupSelector() {
    const nav = document.querySelector('.navbar-actions');
    if (!nav) return;
    let wrap = document.getElementById('group-selector-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'group-selector-wrap';
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">קבוצה:</span><select id="group-select" class="form-select" style="width:96px;padding:6px 10px"></select>';
      const badge = document.getElementById('user-role-badge');
      if (badge && badge.parentNode === nav) nav.insertBefore(wrap, badge);
      else nav.prepend(wrap);
      const sel = document.getElementById('group-select');
      sel.addEventListener('change', (e) => {
        activeGroup = e.target.value;
        localStorage.setItem('activeGroup', activeGroup);
        selectedParticipantId = null;
        const info = document.getElementById('selected-tag-info');
        if (info) info.textContent = `קבוצה פעילה: ${activeGroup}. לא נבחר משתתף.`;
        updateLeaderboard(leaderboardData);
      });
    }

    const sel = document.getElementById('group-select');
    if (!sel) return;
    const groupsSet = new Set();
    (leaderboardData || []).forEach(r => groupsSet.add(normalizeGroup(r.teamId)));
    if (groupsSet.size === 0) {
      for (let i = 1; i <= 8; i++) groupsSet.add(String(i).padStart(2, '0'));
    }
    const groups = Array.from(groupsSet).filter(Boolean).sort();
    sel.innerHTML = groups.map(g => `<option value="${g}">קבוצה ${g}</option>`).join('');
    if (!activeGroup || !groups.includes(activeGroup)) activeGroup = groups[0] || '01';
    sel.value = activeGroup;
    localStorage.setItem('activeGroup', activeGroup);
  }

  const _initAppOrig = initApp;
  initApp = function() {
    _initAppOrig();
    ensureGroupSelector();
    updateLeaderboard(leaderboardData);
  };

  updateAntennaButtons = function(active) {
    const container = document.getElementById('ant-buttons');
    if (!container) return;
    container.innerHTML = '';
    const arr = Array.isArray(active) ? active.slice(0, 8) : [];
    while (arr.length < 8) arr.push(false);
    arr.forEach((on, i) => {
      const btn = document.createElement('button');
      btn.className = 'ant-btn' + (on ? ' on' : '');
      btn.textContent = 'ANT ' + (i + 1);
      btn.onclick = () => espPost(`/ant?i=${i}&v=${on ? 0 : 1}`);
      container.appendChild(btn);
    });
  };

  const _updateLeaderboardOrig = updateLeaderboard;
  updateLeaderboard = function(rows) {
    ensureGroupSelector();
    const filtered = getFilteredRows(rows || []);
    _updateLeaderboardOrig(filtered);
  };

  listenFirebaseTags = function() {
    const racesCol = collection(db, 'races');
    onSnapshot(query(racesCol), (snap) => {
      allRacesCache = [];
      if (snap.empty) return;
      let latest = null;
      snap.forEach(d => {
        const data = d.data();
        allRacesCache.push(data);
        if (!latest || (data.round || 0) > (latest.round || 0)) latest = data;
      });
      if (!latest || !latest.tags) return;
      if (currentUser?.role !== 'operator' && currentUser?.role !== 'admin') {
        leaderboardData = latest.tags.map(t => ({ ...t, comments: t.comments || [] }));
        updateLeaderboard(leaderboardData);
        setStatVal('ev-round', '#' + latest.round);
        setStatVal('ev-status', latest.status === 'running' ? '🟢 סורק' : '🔴 עצור');
        setStatVal('ev-tags', getFilteredRows(latest.tags).length);
      }
    });
  };

  buildChart = function() {
    const ctx = document.getElementById('chart-canvas');
    if (!ctx) return;
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    if (!activeGroup) { showToast('בחר קבוצה להצגת גרף', 'error'); return; }

    const races = (allRacesCache || []).slice().sort((a, b) => (a.round || 0) - (b.round || 0));
    if (races.length === 0) return;

    let targetEpc = selectedParticipantId;
    if (!targetEpc) {
      const first = getFilteredRows(leaderboardData)[0];
      if (first) targetEpc = first.epc;
    }
    if (!targetEpc) { showToast('אין משתתף נבחר בקבוצה זו', 'info'); return; }

    const points = [];
    races.forEach(r => {
      const tags = getFilteredRows(r.tags || []);
      const found = tags.find(t => t.epc === targetEpc);
      if (found) points.push({ round: r.round, place: found.place });
    });
    if (points.length === 0) { showToast('אין היסטוריית סבבים למשתתף שנבחר', 'info'); return; }

    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: points.map(p => `סבב ${p.round}`),
        datasets: [{
          label: `מיקום לאורך סבבים`,
          data: points.map(p => p.place),
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96,165,250,0.15)',
          fill: true,
          tension: 0.25,
          pointRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            reverse: true,
            beginAtZero: false,
            ticks: { precision: 0, color: '#94a3b8' },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          x: { ticks: { color: '#94a3b8' }, grid: { display: false } }
        }
      }
    });
  };
'''

    text = text.replace(marker, patch + "\n\n  " + marker)
    path.write_text(text, encoding="utf-8")


def main():
    root = Path(__file__).resolve().parents[1]
    patch_demo(root / "frontend" / "demo.html")
    patch_app(root / "frontend" / "app.html")
    print("patched demo.html and app.html")


if __name__ == "__main__":
    main()
