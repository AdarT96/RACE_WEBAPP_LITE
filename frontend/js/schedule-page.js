import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, getFirestore, onSnapshot, query, where
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  SCHEDULE_ROW_KINDS, buildTeamScheduleProjection, formatScheduleTime,
  localScheduleClock, normalizeSchedule, parseScheduleTime, scheduleEntryAt, scheduleIssues
} from './schedule-model.js';
import {
  INTENSITY_LABELS, analyzeScheduleLoad, stationIntensityFor
} from './schedule-load-policy.js';
import { ScheduleConflictError, createScheduleRepository } from './schedule-repository.js';
import { EVALUATION_SCHEMA_VERSION } from './evaluation-model.js';
import './station-operational-dialog.js';
import {
  ROLES, canManageSchedule, canViewSchedule, roleLabel
} from './roles.js';

const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let currentUser = null;
let activeEvent = null;
let eventTeams = {};
let stationTypes = { ...(window.DEFAULT_STATION_TYPES || {}) };
let repository = null;
let unsubscribeSchedule = null;
let remoteSchedule = null;
let draftSchedule = null;
let dirty = false;
let saving = false;
let conflict = false;
let currentWarnings = [];
let teamProjection = null;
let operationalRaces = [];
let unsubscribeOperationalRaces = null;

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad2 = value => String(Number(value)).padStart(2, '0');

function showBlocking(message) {
  const element = document.getElementById('schedule-blocking');
  element.textContent = message;
  element.hidden = false;
  document.getElementById('schedule-manager').hidden = true;
  document.getElementById('schedule-team').hidden = true;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3800);
}

function updateBackLink() {
  const link = document.getElementById('schedule-back');
  if (currentUser.role === ROLES.ADMIN) {
    link.href = 'admin.html'; link.textContent = 'ניהול';
  } else if (currentUser.role === ROLES.FORMATION_COMMANDER) {
    link.href = 'commander.html'; link.textContent = 'דשבורד';
  } else {
    link.href = 'app.html'; link.textContent = 'הערכה';
  }
}

async function loadStationTypes() {
  try {
    const snapshot = await getDoc(doc(db, 'settings', 'stationTypes'));
    const saved = snapshot.exists() && snapshot.data()?.types && typeof snapshot.data().types === 'object'
      ? snapshot.data().types : {};
    stationTypes = Object.fromEntries([...new Set([
      ...Object.keys(window.DEFAULT_STATION_TYPES || {}), ...Object.keys(saved)
    ])].map(typeId => [typeId, {
      ...(window.DEFAULT_STATION_TYPES?.[typeId] || {}), ...(saved[typeId] || {})
    }]));
  } catch (error) {
    stationTypes = { ...(window.DEFAULT_STATION_TYPES || {}) };
  }
}

async function getActiveEvent() {
  const pointer = await getDoc(doc(db, 'settings', 'activeEvent'));
  if (!pointer.exists() || pointer.data().status !== 'active' || !pointer.data().eventId) return null;
  const snapshot = await getDoc(doc(db, 'events', String(pointer.data().eventId)));
  return snapshot.exists() && snapshot.data().status === 'active'
    ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function loadEventTeams() {
  if (canManageSchedule(currentUser.role)) {
    const snapshot = await getDocs(collection(db, 'events', activeEvent.id, 'teams'));
    eventTeams = Object.fromEntries(snapshot.docs.map(item => [item.id, { id: item.id, ...item.data() }]));
  } else {
    const team = pad2(currentUser.team);
    const snapshot = await getDoc(doc(db, 'events', activeEvent.id, 'teams', team));
    eventTeams = snapshot.exists() ? { [team]: { id: team, ...snapshot.data() } } : {};
  }
}

function teamIds() {
  return Object.keys(eventTeams).sort((left, right) => Number(left) - Number(right));
}

function teamStationMap(team) {
  return eventTeams[team]?.stationMap && typeof eventTeams[team].stationMap === 'object'
    ? eventTeams[team].stationMap : {};
}

function teamStationMaps() {
  return Object.fromEntries(teamIds().map(team => [team, teamStationMap(team)]));
}

function stationIdsForTeam(team) {
  const count = Number(window.APP_CONFIG?.stationCount) || window.DEFAULT_STATION_ORDER?.length || 17;
  return Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, '0'));
}

function stationTypeId(team, stationId) {
  return teamStationMap(team)?.[stationId] || window.DEFAULT_STATION_ORDER?.[Number(stationId) - 1] || '';
}

function stationName(team, stationId) {
  const typeId = stationTypeId(team, stationId);
  return stationTypes[typeId]?.name || (stationId ? `תחנה ${Number(stationId)}` : 'ללא שיבוץ');
}

function stationIntensity(team, stationId) {
  return stationIntensityFor(team, stationId, { teamStationMaps: teamStationMaps(), stationTypes });
}

function dateLabel(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  return new Intl.DateTimeFormat('he-IL', { weekday:'long', day:'numeric', month:'long', year:'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function evaluationUrl(team, stationId) {
  return `app.html?team=${encodeURIComponent(team)}&station=${encodeURIComponent(stationId)}`;
}

function stationOperationalDialog() {
  return document.getElementById('station-operational-dialog');
}

function setSaveStatus(message) {
  document.getElementById('schedule-save-status').textContent = message;
  document.getElementById('schedule-save-button').disabled = saving || !dirty || conflict;
}

window.markScheduleDirty = () => {
  dirty = true;
  setSaveStatus('יש שינויים שלא נשמרו');
};

function setDraft(next, { preserveReason = false } = {}) {
  draftSchedule = normalizeSchedule(next, teamIds());
  if (!preserveReason) document.getElementById('load-override-reason').value = String(next?.overrideReason || '');
  renderManagerSchedule();
}

function currentRowId(entries) {
  return scheduleEntryAt(entries, new Date())?.id || '';
}

function applyCurrentRowHighlight() {
  const entries = canManageSchedule(currentUser?.role) ? draftSchedule?.rows : teamProjection?.entries;
  const id = currentRowId(entries);
  document.querySelectorAll('[data-schedule-row]').forEach(row => {
    row.classList.toggle('current-row', row.dataset.scheduleRow === id);
    row.classList.toggle('current', row.dataset.scheduleRow === id);
  });
}

function renderLoadWarnings() {
  currentWarnings = analyzeScheduleLoad(draftSchedule, {
    teamStationMaps: teamStationMaps(), stationTypes
  });
  const card = document.getElementById('load-warning-card');
  card.hidden = currentWarnings.length === 0;
  document.getElementById('load-warning-list').innerHTML = currentWarnings
    .map(warning => `<li>${escapeHtml(warning.message)}</li>`).join('');
}

function stationOptions(team, selected) {
  return ['<option value="">— ללא שיבוץ —</option>', ...stationIdsForTeam(team).map(stationId =>
    `<option value="${stationId}" ${stationId === selected ? 'selected' : ''}>${stationId} — ${escapeHtml(stationName(team, stationId))}</option>`
  )].join('');
}

function renderManagerSchedule() {
  if (!draftSchedule) return;
  const ids = draftSchedule.teamIds;
  document.getElementById('schedule-matrix-empty').hidden = draftSchedule.rows.length > 0;
  document.getElementById('schedule-matrix-wrap').hidden = draftSchedule.rows.length === 0;
  document.getElementById('schedule-matrix-head').innerHTML = `<tr>
    <th class="time-column">תאריך ושעה</th>
    ${ids.map(team => `<th><label class="team-header">
      <strong>צוות ${Number(team)}</strong>
      <input class="form-input" maxlength="80" value="${escapeHtml(draftSchedule.commanderNames[team] || '')}"
             oninput="updateCommanderName('${team}',this.value)" placeholder="שם מפקד הצוות">
    </label></th>`).join('')}
  </tr>`;
  document.getElementById('schedule-matrix-body').innerHTML = draftSchedule.rows.map(row => {
    const rowTypeOptions = `<select class="form-select" onchange="updateRowKind('${escapeHtml(row.id)}',this.value)">
      <option value="rotation" ${row.kind === 'rotation' ? 'selected' : ''}>תחנות</option>
      <option value="global" ${row.kind === 'global' ? 'selected' : ''}>משותף</option>
    </select>`;
    const timeCell = `<td class="time-column">
      <div class="schedule-time-editor">
        <input class="form-input" type="date" value="${escapeHtml(row.date)}" onchange="updateRowDate('${escapeHtml(row.id)}',this.value)">
        <input class="form-input" type="time" step="300" value="${formatScheduleTime(row.startMinute)}" onchange="updateRowTime('${escapeHtml(row.id)}',this.value)">
      </div>
      <div class="schedule-row-actions">${rowTypeOptions}<button type="button" class="btn btn-ghost" onclick="removeScheduleRow('${escapeHtml(row.id)}')">מחק</button></div>
    </td>`;
    if (row.kind === SCHEDULE_ROW_KINDS.GLOBAL) {
      return `<tr data-schedule-row="${escapeHtml(row.id)}">${timeCell}
        <td class="global-row-cell" colspan="${Math.max(1, ids.length)}">
          <input class="form-input" maxlength="160" value="${escapeHtml(row.label)}"
                 oninput="updateGlobalLabel('${escapeHtml(row.id)}',this.value)" placeholder="שם הפעילות המשותפת">
        </td></tr>`;
    }
    return `<tr data-schedule-row="${escapeHtml(row.id)}">${timeCell}${ids.map(team => {
      const assignment = row.assignments[team] || { stationId:'', routeNumber:'' };
      const intensity = stationIntensity(team, assignment.stationId);
      return `<td class="schedule-station-cell intensity-${intensity}">
        <div class="station-cell-editor">
          <select class="form-select" onchange="updateAssignment('${escapeHtml(row.id)}','${team}','stationId',this.value)">
            ${stationOptions(team, assignment.stationId)}
          </select>
          <input class="form-input" maxlength="20" value="${escapeHtml(assignment.routeNumber)}"
                 oninput="updateAssignment('${escapeHtml(row.id)}','${team}','routeNumber',this.value)" placeholder="מספר מסלול">
          <div class="station-cell-meta"><span><i class="intensity-dot intensity-${intensity}"></i> ${INTENSITY_LABELS[intensity]}</span>
            ${assignment.stationId
              ? `<button type="button" class="station-open-link" onclick="openStationDetails('${escapeHtml(row.id)}','${team}')">פרטי תחנה</button>` : ''}
          </div>
        </div></td>`;
    }).join('')}</tr>`;
  }).join('');
  renderLoadWarnings();
  applyCurrentRowHighlight();
  document.getElementById('schedule-revision').textContent = draftSchedule.revision
    ? `גרסה ${draftSchedule.revision}` : 'טרם נשמר';
  setSaveStatus(dirty ? 'יש שינויים שלא נשמרו' : 'הלו״ז מעודכן');
}

function findRow(rowId) {
  return draftSchedule?.rows.find(row => row.id === String(rowId));
}

window.updateCommanderName = (team, value) => {
  draftSchedule.commanderNames[team] = String(value || '').slice(0, 80);
  window.markScheduleDirty();
};

window.updateRowDate = (rowId, value) => {
  const row = findRow(rowId); if (!row) return;
  row.date = String(value || '');
  draftSchedule.rows = normalizeSchedule(draftSchedule, teamIds()).rows;
  window.markScheduleDirty(); renderManagerSchedule();
};

window.updateRowTime = (rowId, value) => {
  const row = findRow(rowId); if (!row) return;
  const minute = parseScheduleTime(value);
  if (minute == null) return;
  row.startMinute = minute;
  draftSchedule.rows = normalizeSchedule(draftSchedule, teamIds()).rows;
  window.markScheduleDirty(); renderManagerSchedule();
};

window.updateRowKind = (rowId, kind) => {
  const row = findRow(rowId); if (!row) return;
  row.kind = kind === SCHEDULE_ROW_KINDS.GLOBAL ? SCHEDULE_ROW_KINDS.GLOBAL : SCHEDULE_ROW_KINDS.ROTATION;
  if (row.kind === SCHEDULE_ROW_KINDS.ROTATION) {
    row.assignments = Object.fromEntries(draftSchedule.teamIds.map(team => [team, { stationId:'', routeNumber:'' }]));
  } else {
    row.assignments = {}; row.label = row.label || '';
  }
  window.markScheduleDirty(); renderManagerSchedule();
};

window.updateGlobalLabel = (rowId, value) => {
  const row = findRow(rowId); if (!row) return;
  row.label = String(value || '').slice(0, 160);
  window.markScheduleDirty();
};

window.updateAssignment = (rowId, team, field, value) => {
  const row = findRow(rowId); if (!row || row.kind !== SCHEDULE_ROW_KINDS.ROTATION) return;
  row.assignments[team] ||= { stationId:'', routeNumber:'' };
  row.assignments[team][field] = String(value || '').slice(0, field === 'stationId' ? 2 : 20);
  window.markScheduleDirty();
  if (field === 'stationId') renderManagerSchedule();
  else renderLoadWarnings();
};

window.removeScheduleRow = rowId => {
  const row = findRow(rowId);
  if (!row || !confirm(`למחוק את השורה של ${formatScheduleTime(row.startMinute)}?`)) return;
  draftSchedule.rows = draftSchedule.rows.filter(item => item.id !== row.id);
  window.markScheduleDirty(); renderManagerSchedule();
};

window.openStationDetails = (rowId, team) => {
  const row = findRow(rowId);
  const assignment = row?.kind === SCHEDULE_ROW_KINDS.ROTATION ? row.assignments?.[team] : null;
  if (!row || !assignment?.stationId) return;
  stationOperationalDialog()?.show({
    team, stationId: assignment.stationId, stationName: stationName(team, assignment.stationId),
    routeNumber: assignment.routeNumber,
    scheduledLabel: `${dateLabel(row.date)} · ${formatScheduleTime(row.startMinute)}`,
    races: operationalRaces, nowMs: Date.now()
  });
};

window.toggleNewRowLabel = () => {
  document.getElementById('new-row-label-wrap').hidden =
    document.getElementById('new-row-kind').value !== SCHEDULE_ROW_KINDS.GLOBAL;
};

window.addScheduleRow = () => {
  const date = document.getElementById('new-row-date').value;
  const startMinute = parseScheduleTime(document.getElementById('new-row-time').value);
  const kind = document.getElementById('new-row-kind').value === SCHEDULE_ROW_KINDS.GLOBAL
    ? SCHEDULE_ROW_KINDS.GLOBAL : SCHEDULE_ROW_KINDS.ROTATION;
  const label = String(document.getElementById('new-row-label').value || '').trim();
  if (!date || startMinute == null) { showToast('יש לבחור תאריך ושעה', 'error'); return; }
  if (kind === SCHEDULE_ROW_KINDS.GLOBAL && !label) { showToast('יש להזין שם לפעילות המשותפת', 'error'); return; }
  const id = `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  draftSchedule.rows.push({
    id, date, startMinute, kind, label: kind === SCHEDULE_ROW_KINDS.GLOBAL ? label : '',
    assignments: kind === SCHEDULE_ROW_KINDS.ROTATION
      ? Object.fromEntries(draftSchedule.teamIds.map(team => [team, { stationId:'', routeNumber:'' }])) : {}
  });
  draftSchedule.rows = normalizeSchedule(draftSchedule, teamIds()).rows;
  window.markScheduleDirty(); renderManagerSchedule();
  document.getElementById('new-row-label').value = '';
  const nextMinute = Math.min(1435, startMinute + 30);
  document.getElementById('new-row-time').value = formatScheduleTime(nextMinute);
};

window.reloadScheduleDraft = () => {
  if (dirty && !confirm('לבטל את כל השינויים שלא נשמרו?')) return;
  dirty = false; conflict = false;
  document.getElementById('schedule-conflict').hidden = true;
  setDraft(remoteSchedule || { teamIds: teamIds(), commanderNames:{}, rows:[], revision:0 });
};

window.saveSchedule = async () => {
  if (saving || !dirty || conflict) return;
  const stationIdsByTeam = Object.fromEntries(draftSchedule.teamIds
    .map(team => [team, stationIdsForTeam(team)]));
  const issues = scheduleIssues(draftSchedule, { stationIdsByTeam });
  if (issues.length) { showToast(issues[0], 'error'); return; }
  const overrideReason = document.getElementById('load-override-reason').value;
  if (currentWarnings.length && !overrideReason.trim()) {
    showToast('יש לתעד סיבה לשמירת לו״ז עם אזהרות עומס', 'error'); return;
  }
  saving = true; setSaveStatus('שומר את כל הצוותים…');
  try {
    const revision = await repository.saveMaster({
      eventId: activeEvent.id, schedule: draftSchedule,
      expectedRevision: draftSchedule.revision, warnings: currentWarnings,
      overrideReason, stationIdsByTeam
    });
    dirty = false;
    conflict = false;
    document.getElementById('schedule-conflict').hidden = true;
    draftSchedule.revision = revision;
    setSaveStatus(`גרסה ${revision} נשמרה`);
    showToast('הלו״ז נשמר לכל הצוותים ✓', 'success');
  } catch (error) {
    if (error instanceof ScheduleConflictError) {
      conflict = true;
      document.getElementById('schedule-conflict').hidden = false;
    }
    showToast(error.message || 'שמירת הלו״ז נכשלה', 'error');
    setSaveStatus('השמירה נכשלה');
  } finally {
    saving = false;
    setSaveStatus(conflict ? 'נדרשת טעינת גרסה עדכנית' : dirty ? 'יש שינויים שלא נשמרו' : 'הלו״ז מעודכן');
  }
};

function renderTeamSchedule() {
  const list = document.getElementById('team-schedule-list');
  const empty = document.getElementById('team-schedule-empty');
  const entries = Array.isArray(teamProjection?.entries) ? teamProjection.entries : [];
  empty.hidden = entries.length > 0;
  list.innerHTML = '';
  if (!entries.length) {
    document.getElementById('team-current-card').hidden = true;
    document.getElementById('schedule-revision').textContent = '';
    return;
  }
  const team = String(teamProjection.team || pad2(currentUser.team));
  const current = scheduleEntryAt(entries, new Date(), teamProjection.timeZone);
  const currentCard = document.getElementById('team-current-card');
  if (current) {
    const stationText = current.kind === SCHEDULE_ROW_KINDS.GLOBAL
      ? current.label : stationName(team, current.stationId);
    currentCard.innerHTML = `<h2>עכשיו: ${escapeHtml(stationText)}</h2>
      <p>${formatScheduleTime(current.startMinute)}${current.routeNumber ? ` · מסלול ${escapeHtml(current.routeNumber)}` : ''}</p>
      ${current.kind === SCHEDULE_ROW_KINDS.ROTATION && current.stationId
        ? `<a class="btn btn-primary" href="${evaluationUrl(team, current.stationId)}">פתח הערכה</a>` : ''}`;
    currentCard.hidden = false;
  } else currentCard.hidden = true;
  const byDate = entries.reduce((map, entry) => {
    (map[entry.date] ||= []).push(entry); return map;
  }, {});
  list.innerHTML = Object.entries(byDate).map(([date, dayEntries]) => `<section class="team-day">
    <h2 class="team-day-title">${escapeHtml(dateLabel(date))}</h2>
    ${dayEntries.map(entry => {
      const isCurrent = entry.id === current?.id;
      if (entry.kind === SCHEDULE_ROW_KINDS.GLOBAL) {
        return `<div class="team-entry global ${isCurrent ? 'current' : ''}" data-schedule-row="${escapeHtml(entry.id)}">
          <strong class="team-entry-time">${formatScheduleTime(entry.startMinute)}</strong>
          <div class="team-entry-main"><strong>${escapeHtml(entry.label)}</strong><span>פעילות משותפת</span></div>
        </div>`;
      }
      const intensity = stationIntensity(team, entry.stationId);
      const content = `<strong class="team-entry-time">${formatScheduleTime(entry.startMinute)}</strong>
        <div class="team-entry-main"><strong>${escapeHtml(stationName(team, entry.stationId))}</strong>
          <span>${entry.routeNumber ? `מסלול ${escapeHtml(entry.routeNumber)}` : 'ללא מספר מסלול'}</span></div>
        <span class="team-entry-intensity"><i class="intensity-dot intensity-${intensity}"></i>${INTENSITY_LABELS[intensity]}</span>`;
      return entry.stationId
        ? `<a class="team-entry ${isCurrent ? 'current' : ''}" data-schedule-row="${escapeHtml(entry.id)}" href="${evaluationUrl(team, entry.stationId)}">${content}</a>`
        : `<div class="team-entry" data-schedule-row="${escapeHtml(entry.id)}">${content}</div>`;
    }).join('')}
  </section>`).join('');
  const commander = teamProjection.commanderName ? ` · מפקד: ${teamProjection.commanderName}` : '';
  document.getElementById('schedule-subtitle').textContent = `צוות ${Number(team)}${commander}`;
  document.getElementById('schedule-revision').textContent = `גרסה ${teamProjection.sourceRevision || 0}`;
  applyCurrentRowHighlight();
}

function subscribeToSchedule() {
  unsubscribeSchedule?.();
  if (canManageSchedule(currentUser.role)) {
    document.getElementById('schedule-manager').hidden = false;
    document.getElementById('schedule-team').hidden = true;
    unsubscribeSchedule = repository.subscribeMaster(activeEvent.id, value => {
      remoteSchedule = value;
      const revision = Number(value?.revision || 0);
      if (!dirty) {
        conflict = false;
        document.getElementById('schedule-conflict').hidden = true;
        setDraft(value || { teamIds:teamIds(), commanderNames:{}, rows:[], revision:0 });
      } else if (revision !== Number(draftSchedule?.revision || 0)) {
        conflict = true;
        document.getElementById('schedule-conflict').hidden = false;
        setSaveStatus('הלו״ז השתנה במכשיר אחר');
      }
    }, error => showBlocking('טעינת הלו״ז נכשלה: ' + error.message));
  } else {
    const team = pad2(currentUser.team);
    document.getElementById('schedule-manager').hidden = true;
    document.getElementById('schedule-team').hidden = false;
    unsubscribeSchedule = repository.subscribeTeam(activeEvent.id, team, value => {
      teamProjection = value;
      renderTeamSchedule();
    }, error => showBlocking('טעינת הלו״ז הצוותי נכשלה: ' + error.message));
  }
}

function subscribeToOperationalRaces() {
  unsubscribeOperationalRaces?.();
  operationalRaces = [];
  if (!canManageSchedule(currentUser?.role) || !activeEvent?.id) return;
  unsubscribeOperationalRaces = onSnapshot(query(collection(db, 'races'),
    where('eventId', '==', activeEvent.id),
    where('evaluationSchemaVersion', '==', EVALUATION_SCHEMA_VERSION)), snapshot => {
    operationalRaces = snapshot.docs.map(item => ({ id:item.id, ...item.data() }));
    stationOperationalDialog()?.refresh({ races: operationalRaces, nowMs: Date.now() });
  }, error => showToast('מצב הסבבים אינו זמין כרגע: ' + error.message, 'error'));
}

async function initializePage() {
  updateBackLink();
  document.getElementById('schedule-user').textContent = `${currentUser.name || ''} · ${roleLabel(currentUser.role)}`;
  await Promise.all([loadStationTypes(), getActiveEvent().then(value => { activeEvent = value; })]);
  if (!activeEvent) { showBlocking('אין אירוע גיבוש פעיל.'); return; }
  document.getElementById('schedule-title').textContent = activeEvent.name || 'לו״ז גיבוש';
  document.getElementById('schedule-subtitle').textContent = canManageSchedule(currentUser.role)
    ? 'מבט־על ועריכת שיבוץ לכל הצוותים' : `לו״ז צוות ${Number(currentUser.team)}`;
  await loadEventTeams();
  if (!teamIds().length) { showBlocking('לא נמצאו צוותים באירוע הפעיל.'); return; }
  repository = createScheduleRepository(db, currentUser);
  const clock = localScheduleClock(new Date());
  document.getElementById('new-row-date').value = clock.date;
  document.getElementById('new-row-time').value = formatScheduleTime(
    Math.min(1435, Math.ceil(clock.startMinute / 5) * 5)
  );
  window.toggleNewRowLabel();
  subscribeToOperationalRaces();
  subscribeToSchedule();
}

window.logout = async () => { await signOut(auth); location.href = 'index.html'; };
window.addEventListener('beforeunload', event => {
  if (!dirty) return;
  event.preventDefault(); event.returnValue = '';
});
setInterval(() => {
  if (canManageSchedule(currentUser?.role)) applyCurrentRowHighlight();
  else if (teamProjection) renderTeamSchedule();
  stationOperationalDialog()?.refresh({ races: operationalRaces, nowMs: Date.now() });
}, 30000);

onAuthStateChanged(auth, async user => {
  if (!user) { location.href = 'index.html'; return; }
  try {
    const snapshot = await getDoc(doc(db, 'users', user.uid));
    const profile = snapshot.exists() ? snapshot.data() : null;
    if (!profile || (!profile.approved && profile.role !== ROLES.ADMIN) || !canViewSchedule(profile.role)) {
      await signOut(auth); location.href = 'index.html'; return;
    }
    currentUser = { ...profile, uid:user.uid };
    await initializePage();
  } catch (error) {
    showBlocking('הכניסה ללו״ז נכשלה: ' + error.message);
  }
});
