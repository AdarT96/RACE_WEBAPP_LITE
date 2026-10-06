import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import {
  collection, doc, getDoc, getDocs, getFirestore
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  buildCandidateRosterImport, candidateRowsFromMatrix, IMPORT_FIELD_LABELS
} from './candidate-roster-import.js';
import { createEventSetupRepository } from './event-setup-repository.js';
import {
  ARTIFACT_STATUSES, EVENT_STATUSES, eventSetupReadiness, normalizeEventTeamId, eventTeamIds
} from './event-setup-model.js';
import { CLEARANCE_LABELS, padTeam, normalizeCandidateProfile } from './formation-operations-model.js';
import { ROLES, roleLabel, roleNeedsTeam } from './roles.js';
import { buildScheduleImport, scheduleImportTemplateCsv } from './schedule-excel-adapter.js';
import { scheduleIssues, SCHEDULE_MAX_TEAMS } from './schedule-model.js';
import { createScheduleRepository } from './schedule-repository.js';

const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let currentUser = null;
let repository = null;
let scheduleRepository = null;
let currentEventId = '';
let bundle = null;
let users = [];
let rosterBusy = false;
let candidateImportPreview = null;
let stationTypes = { ...(window.DEFAULT_STATION_TYPES || {}) };

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const activeStaff = () => (bundle?.staff || []).filter(member => member.active !== false);
const teamIds = () => eventTeamIds(bundle || {});

function teamIdsFromInput() {
  const tokens = document.getElementById('team-numbers').value.split(/[,;\s]+/).filter(Boolean);
  const invalid = tokens.find(token => !normalizeEventTeamId(token));
  if (invalid) throw new Error(`מספר הצוות "${invalid}" אינו תקין. ניתן להזין 1–${SCHEDULE_MAX_TEAMS}.`);
  return [...new Set(tokens.map(normalizeEventTeamId))];
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function showAlert(message, type = 'warning') {
  const element = document.getElementById('page-alert');
  element.className = `alert alert-${type}`;
  element.textContent = message;
  element.hidden = !message;
}

function setBusy(button, busy, label = 'שומר…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label;
  } else if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
  button.disabled = busy;
}

function defaultStationMap() {
  return Object.fromEntries((window.DEFAULT_STATION_ORDER || []).map((typeId, index) => [
    String(index + 1).padStart(2, '0'), typeId
  ]));
}

function lockRosterWorkspace() {
  rosterBusy = true;
  const controls = [...document.querySelectorAll('#setup-workspace button, #setup-workspace input, #setup-workspace select, #existing-events, #create-event-button, #new-event-name')];
  const states = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  return () => {
    controls.forEach((control, index) => { control.disabled = states[index]; });
    rosterBusy = false;
  };
}

window.addEventListener('beforeunload', event => {
  if (!rosterBusy) return;
  event.preventDefault();
  event.returnValue = '';
});

function stationMapForTeam(team) {
  return bundle?.teams?.find(item => item.id === team)?.stationMap || defaultStationMap();
}

function stationCatalogByTeam(ids = teamIds()) {
  return Object.fromEntries(ids.map(team => [team, Object.entries(stationMapForTeam(team)).map(([id, typeId]) => ({
    id, name:stationTypes[typeId]?.name || window.DEFAULT_STATION_TYPES?.[typeId]?.name || `תחנה ${Number(id)}`
  }))]));
}

async function loadStationTypes() {
  try {
    const snapshot = await getDoc(doc(db, 'settings', 'stationTypes'));
    const saved = snapshot.exists() && typeof snapshot.data()?.types === 'object' ? snapshot.data().types : {};
    stationTypes = Object.fromEntries([...new Set([
      ...Object.keys(window.DEFAULT_STATION_TYPES || {}), ...Object.keys(saved)
    ])].map(typeId => [typeId, { ...(window.DEFAULT_STATION_TYPES?.[typeId] || {}), ...(saved[typeId] || {}) }]));
  } catch (_) {
    stationTypes = { ...(window.DEFAULT_STATION_TYPES || {}) };
  }
}

async function workbookMatrix(file) {
  if (!file) throw new Error('יש לבחור קובץ.');
  if (!window.XLSX) throw new Error('רכיב קריאת Excel לא נטען. בדוק חיבור לאינטרנט ונסה שוב.');
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type:'array', cellDates:true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('הקובץ אינו מכיל גיליון.');
  return window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header:1, raw:true, defval:'' });
}

async function loadUsers() {
  const snapshot = await getDocs(collection(db, 'users'));
  users = snapshot.docs.map(item => ({ uid:item.id, ...item.data() }))
    .filter(user => user.role !== ROLES.ADMIN && user.approved === true)
    .sort((left, right) => String(left.name || left.email || '').localeCompare(String(right.name || right.email || ''), 'he'));
}

async function refreshBundle({ render = true } = {}) {
  if (!currentEventId) return;
  bundle = await repository.load(currentEventId);
  if (render) renderWorkspace();
}

function renderEventPicker(events) {
  const wrap = document.getElementById('existing-events-wrap');
  const select = document.getElementById('existing-events');
  wrap.hidden = events.length === 0;
  select.innerHTML = '<option value="">— בחירת אירוע —</option>' + events.map(event =>
    `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name || event.id)} · ${event.status === 'active' ? 'פעיל' : 'טיוטה'}</option>`
  ).join('');
}

function renderCandidateTeamOptions() {
  const select = document.getElementById('candidate-team');
  const previous = select.value;
  select.innerHTML = teamIds().map(team => `<option value="${team}">צוות ${Number(team)}</option>`).join('');
  if (teamIds().includes(previous)) select.value = previous;
  renderCandidateRows();
}

function clearanceOptions(selected) {
  return Object.entries(CLEARANCE_LABELS).map(([value, label]) =>
    `<option value="${value}" ${Number(value) === Number(selected) ? 'selected' : ''}>${escapeHtml(label)}</option>`
  ).join('');
}

function candidateRow(candidate = {}) {
  const removalDisabled = Boolean(candidate.id && bundle?.event?.status === EVENT_STATUSES.ACTIVE);
  candidate = normalizeCandidateProfile(candidate);
  return `<div class="candidate-row" data-candidate-row>
    <label><span>מספר מועמד</span><input class="form-input" data-field="participantId" inputmode="numeric" value="${escapeHtml(candidate.participantId || '')}" placeholder="מספר"
      ${removalDisabled ? 'readonly title="מספר מועמד קיים אינו משתנה לאחר הפעלת האירוע"' : ''}></label>
    <label><span>שם מלא</span><input class="form-input" data-field="fullName" maxlength="80" value="${escapeHtml(candidate.fullName === '0' ? '' : candidate.fullName || '')}" placeholder="0 אם חסר"></label>
    <label><span>תעודת זהות</span><input class="form-input" data-field="nationalId" inputmode="numeric" value="${escapeHtml(candidate.nationalId === '0' ? '' : candidate.nationalId || '')}" placeholder="0 אם חסר"></label>
    <label><span>טלפון חירום</span><input class="form-input" data-field="emergencyContactPhone" inputmode="tel" value="${escapeHtml(candidate.emergencyContactPhone === '0' ? '' : candidate.emergencyContactPhone || '')}" placeholder="0 אם חסר"></label>
    <label><span>כשירות רופא</span><select class="form-select" data-field="doctorClearance">${clearanceOptions(candidate.doctorClearance || 0)}</select></label>
    <label><span>כשירות חובש</span><select class="form-select" data-field="medicClearance">${clearanceOptions(candidate.medicClearance || 0)}</select></label>
    <button class="btn btn-ghost" data-remove-candidate type="button" ${removalDisabled ? 'disabled title="באירוע פעיל משנים סטטוס דרך מסך המועמד"' : ''}>הסר</button>
  </div>`;
}

function renderCandidateRows() {
  const team = document.getElementById('candidate-team').value;
  const rows = (bundle?.candidates || []).filter(candidate => candidate.team === team)
    .sort((left, right) => Number(left.participantId) - Number(right.participantId));
  const container = document.getElementById('candidate-table');
  container.innerHTML = `<div class="candidate-row header">
    <span>מספר מועמד</span><span>שם מלא</span><span>תעודת זהות</span><span>טלפון חירום</span>
    <span>כשירות רופא</span><span>כשירות חובש</span><span></span>
  </div>${rows.map(candidateRow).join('')}`;
  if (!rows.length) container.insertAdjacentHTML('beforeend', candidateRow());
}

function staffMemberSelection(user) {
  return activeStaff().find(member => member.uid === user.uid) || null;
}

function renderStaff() {
  const teams = teamIds();
  const container = document.getElementById('staff-list');
  container.innerHTML = users.map(user => {
    const selected = staffMemberSelection(user);
    const role = selected?.role || ([ROLES.OPERATOR, ROLES.EVALUATOR, ROLES.FORMATION_COMMANDER].includes(user.role) ? user.role : ROLES.EVALUATOR);
    const team = selected?.team || padTeam(user.team) || teams[0] || '';
    return `<div class="staff-row" data-staff-row data-uid="${escapeHtml(user.uid)}">
      <label class="staff-identity"><input data-field="selected" type="checkbox" ${selected ? 'checked' : ''}>
        <span><strong>${escapeHtml(user.name || user.email || user.uid)}</strong><br><small>${escapeHtml(user.email || '')}</small></span></label>
      <select class="form-select" data-field="role">
        <option value="operator" ${role === ROLES.OPERATOR ? 'selected' : ''}>מפק״צ</option>
        <option value="evaluator" ${role === ROLES.EVALUATOR ? 'selected' : ''}>מעריך</option>
        <option value="formation_commander" ${role === ROLES.FORMATION_COMMANDER ? 'selected' : ''}>מפקד הגיבוש</option>
      </select>
      <select class="form-select" data-field="team" ${roleNeedsTeam(role) ? '' : 'disabled hidden'}>
        ${teams.map(id => `<option value="${id}" ${id === team ? 'selected' : ''}>צוות ${Number(id)}</option>`).join('')}
      </select>
      <span data-team-scope ${roleNeedsTeam(role) ? 'hidden' : ''}>כל הגיבוש</span>
    </div>`;
  }).join('') || '<p>אין משתמשים זמינים לשיבוץ. יש לאשר משתמשים בפאנל המנהל.</p>';
}

function scheduleErrors() {
  if (!bundle?.schedule) return [];
  return scheduleIssues(bundle.schedule, {
    stationIdsByTeam:Object.fromEntries(teamIds().map(team => [team, Object.keys(stationMapForTeam(team))]))
  });
}

function readiness() {
  return eventSetupReadiness({ ...bundle, scheduleErrors:scheduleErrors() });
}

function renderReadiness() {
  const state = readiness();
  const list = (id, items, empty) => {
    const element = document.getElementById(id);
    element.parentElement.classList.toggle('has-issues', items.length > 0);
    element.innerHTML = items.length
      ? items.map(item => `<li>${escapeHtml(item)}</li>`).join('') : `<li>${escapeHtml(empty)}</li>`;
  };
  list('readiness-blockers', state.blockers, 'אין בעיות חוסמות.');
  list('readiness-warnings', state.warnings, 'אין אזהרות.');
  document.getElementById('activation-summary').textContent =
    `${state.counts.teams} צוותים · ${state.counts.candidates} מועמדים · ${state.counts.staff} אנשי צוות`;
  const button = document.getElementById('activate-event-button');
  button.disabled = !state.canActivate || bundle.event.status !== EVENT_STATUSES.DRAFT;
  button.textContent = bundle.event.status === EVENT_STATUSES.ACTIVE ? 'האירוע פעיל' : 'פרסם לו״ז והפעל אירוע';
}

function renderWorkspace() {
  document.getElementById('event-picker').hidden = true;
  document.getElementById('setup-workspace').hidden = false;
  document.getElementById('event-name').value = bundle.event.name || '';
  document.getElementById('event-status').textContent = bundle.event.status === EVENT_STATUSES.ACTIVE ? 'אירוע פעיל' : 'טיוטה';
  document.getElementById('team-numbers').value = teamIds().map(Number).join(', ');
  document.getElementById('open-schedule-button').href =
    `schedule.html?eventId=${encodeURIComponent(currentEventId)}&return=setup`;
  const schedule = bundle.schedule;
  document.getElementById('schedule-summary').textContent = schedule
    ? `${schedule.teamIds?.length || 0} צוותים · ${schedule.rows?.length || 0} שורות · ${bundle.publishedSchedule ? `פורסם בגרסה ${bundle.publishedSchedule.revision}` : 'טרם פורסם'}`
    : 'טרם הוגדר לו״ז.';
  renderCandidateTeamOptions();
  renderStaff();
  renderReadiness();
}

function selectedStaffFromDom() {
  return [...document.querySelectorAll('[data-staff-row]')].flatMap(row => {
    if (!row.querySelector('[data-field="selected"]').checked) return [];
    const role = row.querySelector('[data-field="role"]').value;
    const user = users.find(item => item.uid === row.dataset.uid);
    return [{
      uid:row.dataset.uid,
      displayName:user?.name || user?.email || row.dataset.uid,
      role,
      team:role === ROLES.FORMATION_COMMANDER ? '' : row.querySelector('[data-field="team"]').value,
      active:true
    }];
  });
}

async function selectEvent(eventId) {
  clearCandidateImportPreview();
  currentEventId = String(eventId || '');
  if (!currentEventId) return;
  history.replaceState(null, '', `event-setup.html?eventId=${encodeURIComponent(currentEventId)}`);
  await refreshBundle();
}

async function saveTeamTopology(ids) {
  const mergedIds = [...new Set([...teamIds(), ...ids].map(normalizeEventTeamId).filter(Boolean))]
    .sort((left, right) => Number(left) - Number(right));
  await repository.ensureTeams(currentEventId, mergedIds, defaultStationMap);
  await refreshBundle();
}

async function postToSheets(body) {
  if (!window.APP_CONFIG?.sheetsApiUrl || window.APP_CONFIG.sheetsApiUrl.startsWith('YOUR_')) {
    throw new Error('כתובת Google Apps Script לא הוגדרה.');
  }
  if (window.APP_CONFIG.sheetsApiKey && !window.APP_CONFIG.sheetsApiKey.startsWith('YOUR_')) {
    body.key = window.APP_CONFIG.sheetsApiKey;
  }
  const response = await fetch(window.APP_CONFIG.sheetsApiUrl, { method:'POST', body:JSON.stringify(body) });
  if (!response.ok) throw new Error(`Google Apps Script החזיר HTTP ${response.status}.`);
  const data = await response.json();
  if (!data.success) throw new Error(data.message || 'הפעולה נכשלה.');
  return data;
}

async function verifyEventDriveApi() {
  const response = await fetch(window.APP_CONFIG.sheetsApiUrl);
  if (!response.ok) throw new Error('לא ניתן לבדוק את פריסת Google Apps Script.');
  const data = await response.json();
  if (!Array.isArray(data.features) || !data.features.includes('event_scoped_files')) {
    throw new Error('גרסת Google Apps Script הפעילה עדיין אינה תומכת בקבצים לפי אירוע. יש לפרוס את Code.gs החדש לפני יצירת קבצים.');
  }
}

document.getElementById('create-event-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true, 'יוצר…');
  try {
    const id = await repository.createDraft(document.getElementById('new-event-name').value);
    await selectEvent(id);
    showToast('טיוטת האירוע נוצרה.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

// כרטיסי השלבים מתקפלים כמו בפאנל המנהל. המצב נזכר במכשיר; קישור לשלב —
// מסרגל השלבים או מכתובת עם # (למשל מפאנל המנהל לשלב 5) — פותח את הכרטיס.
// את ה-# שומרים כבר עכשיו: selectEvent מחליף את הכתובת ומוחק אותו.
const initialCardId = location.hash.slice(1);
const collapseKey = id => `lite:setupCard:${id}`;

function openSetupCard(id, { scroll = false } = {}) {
  const card = id ? document.getElementById(id) : null;
  if (card?.tagName !== 'DETAILS') return;
  card.open = true;
  if (scroll) card.scrollIntoView({ block: 'start' });
}

document.querySelectorAll('details.collapsible-card').forEach(card => {
  try {
    const saved = localStorage.getItem(collapseKey(card.id));
    if (saved !== null) card.open = saved === '1';
  } catch (_) { /* בלי אחסון — נשארים בברירת המחדל */ }
  card.addEventListener('toggle', () => {
    try { localStorage.setItem(collapseKey(card.id), card.open ? '1' : '0'); } catch (_) { /* לא קריטי */ }
  });
});
// הפתיחה קודמת לגלילה של הקישור עצמו, כך שהדפדפן גולל לכרטיס פתוח
document.querySelectorAll('.setup-steps a[href^="#"]').forEach(link => {
  link.addEventListener('click', () => openSetupCard(link.getAttribute('href').slice(1)));
});

document.getElementById('existing-events').addEventListener('change', event => selectEvent(event.target.value));
document.getElementById('logout-button').addEventListener('click', async () => {
  await signOut(auth); location.href = 'index.html';
});

document.getElementById('save-details-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true);
  try {
    await repository.saveDetails(currentEventId, document.getElementById('event-name').value);
    await refreshBundle(); showToast('שם האירוע נשמר.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

document.getElementById('save-teams-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true);
  try {
    const ids = teamIdsFromInput();
    await saveTeamTopology([...new Set(ids)]);
    showToast('רשימת הצוותים נשמרה באירוע. ניתן לשבץ אותם בלו״ז בנפרד.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

document.getElementById('download-schedule-template').addEventListener('click', () => {
  let ids = [];
  try { ids = teamIdsFromInput(); } catch (error) { showToast(error.message, 'error'); return; }
  const blob = new Blob([scheduleImportTemplateCsv(ids.length ? ids : [1])], { type:'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = 'schedule-template.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

document.getElementById('import-schedule-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true, 'מייבא…');
  try {
    const matrix = await workbookMatrix(document.getElementById('schedule-file').files[0]);
    const imported = buildScheduleImport({ matrix, stationCatalogByTeam:stationCatalogByTeam(
      Array.from({ length:SCHEDULE_MAX_TEAMS }, (_, index) => String(index + 1).padStart(2, '0'))
    ) });
    if (imported.errors.length) throw new Error(imported.errors[0]);
    await scheduleRepository.saveDraft({
      eventId:currentEventId, schedule:imported.schedule,
      ensureTeamStationMaps:Object.fromEntries(imported.schedule.teamIds.map(team => [team, stationMapForTeam(team)])),
      expectedPublishedRevision:Number(bundle.publishedSchedule?.revision || 0),
      expectedDraftRevision:Number(bundle.schedule?.draftRevision || 0),
      stationIdsByTeam:Object.fromEntries(imported.schedule.teamIds.map(team => [team, Object.keys(stationMapForTeam(team))]))
    });
    await refreshBundle(); showToast('הלו״ז יובא ונשמר כטיוטה.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

document.getElementById('candidate-team').addEventListener('change', renderCandidateRows);
document.getElementById('add-candidate-button').addEventListener('click', () => {
  document.getElementById('candidate-table').insertAdjacentHTML('beforeend', candidateRow());
});
document.getElementById('candidate-table').addEventListener('click', event => {
  if (event.target.closest('[data-remove-candidate]')) event.target.closest('[data-candidate-row]').remove();
});

document.getElementById('save-candidates-button').addEventListener('click', async event => {
  if (rosterBusy) return;
  const button = event.currentTarget;
  const unlock = lockRosterWorkspace();
  setBusy(button, true);
  try {
    const team = document.getElementById('candidate-team').value;
    if (!team) throw new Error('יש להגדיר צוותים לפני הוספת מועמדים.');
    const candidates = [...document.querySelectorAll('[data-candidate-row]')].map(row => Object.fromEntries(
      [...row.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value || '0'])
    )).filter(candidate => candidate.participantId && candidate.participantId !== '0');
    await repository.replaceTeamCandidates(currentEventId, team, candidates);
    await refreshBundle(); showToast(`מועמדי צוות ${Number(team)} נשמרו.`, 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { unlock(); setBusy(button, false); }
});

function clearCandidateImportPreview() {
  candidateImportPreview = null;
  document.getElementById('candidate-import-preview').hidden = true;
  document.getElementById('confirm-candidate-import').hidden = true;
}

document.getElementById('candidate-file').addEventListener('change', clearCandidateImportPreview);

document.getElementById('import-candidates-button').addEventListener('click', async event => {
  if (rosterBusy) return;
  const button = event.currentTarget;
  const unlock = lockRosterWorkspace();
  setBusy(button, true, 'בודק…');
  clearCandidateImportPreview();
  try {
    const file = document.getElementById('candidate-file').files[0];
    const adapted = candidateRowsFromMatrix(await workbookMatrix(file));
    if (adapted.errors.length) throw new Error(adapted.errors.join('\n'));
    const result = buildCandidateRosterImport({ rows:adapted.rows,
      source:{ type:'excel', fileName:file.name }, allowIncompleteProfiles:true });
    if (result.errors.length) throw new Error(result.errors.join('\n'));
    const preview = document.getElementById('candidate-import-preview');
    preview.innerHTML = `<h3>${adapted.rows.length} מועמדים · ${result.teams.length} צוותים</h3>
      <p>ייבוא מעדכן פרטים שסופקו בקובץ. שדה ריק או עמודה חסרה לא מוחקים מידע קיים.
      באירוע פעיל הערכות וסטטוס מועמד נשמרים; בטיוטה רשימת כל צוות בקובץ מוחלפת.</p>
      <ul>${result.teams.map(group => `<li>צוות ${Number(group.team)}: ${group.candidates.length} מועמדים${teamIds().includes(group.team) ? '' : ' — צוות חדש'}</li>`).join('')}</ul>
      <table><thead><tr><th>שדה</th><th>עמודה שזוהתה</th></tr></thead><tbody>${Object.entries(adapted.mapping)
        .map(([field, header]) => `<tr><td>${escapeHtml(IMPORT_FIELD_LABELS[field])}</td><td>${escapeHtml(header || 'לא נמצאה')}</td></tr>`).join('')}</tbody></table>
      <ul>${adapted.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>
      <details><summary>דוגמה לנתונים שייקלטו</summary><table><thead><tr><th>צוות</th><th>מועמד</th><th>שם מלא</th><th>תעודת זהות</th></tr></thead>
      <tbody>${adapted.rows.slice(0,5).map(candidate => `<tr><td>${escapeHtml(candidate.team)}</td><td>${escapeHtml(candidate.participantId)}</td><td>${escapeHtml(candidate.fullName)}</td><td dir="ltr">${escapeHtml(candidate.nationalId)}</td></tr>`).join('')}</tbody></table></details>`;
    candidateImportPreview = { eventId:currentEventId, result };
    preview.hidden = false;
    document.getElementById('confirm-candidate-import').hidden = false;
    document.getElementById('candidate-import-progress').textContent = 'הבדיקה הסתיימה. עדיין לא נשמר דבר — יש לאשר את הייבוא.';
  } catch (error) {
    document.getElementById('candidate-import-progress').textContent = error.message;
    showToast(error.message, 'error');
  } finally { unlock(); setBusy(button, false); }
});

document.getElementById('confirm-candidate-import').addEventListener('click', async event => {
  if (rosterBusy) return;
  const button = event.currentTarget;
  const unlock = lockRosterWorkspace();
  const progress = document.getElementById('candidate-import-progress');
  setBusy(button, true, 'מייבא…');
  progress.textContent = 'קורא את הקובץ ובודק את הנתונים…';
  let saved = false;
  try {
    if (!candidateImportPreview || candidateImportPreview.eventId !== currentEventId) throw new Error('יש לבדוק את הקובץ מחדש לפני הייבוא.');
    const { result } = candidateImportPreview;
    progress.textContent = 'טוען את הרשימות הקיימות ומכין את השמירה…';
    const summary = await repository.importCandidates(currentEventId, result.teams, result.source, {
      onProgress:({ completedTeams, totalTeams }) => {
        progress.textContent = `נשמרו ${completedTeams} מתוך ${totalTeams} צוותים…`;
      }
    });
    saved = true;
    clearCandidateImportPreview();
    progress.textContent = `נשמרו ${summary.importedCount} מועמדים ב־${summary.teams} צוותים. מרענן את המסך…`;
    await refreshBundle();
    progress.textContent = `הייבוא הושלם: ${summary.importedCount} מועמדים ב־${summary.teams} צוותים.`;
    showToast('ייבוא המועמדים הושלם.', 'success');
  } catch (error) {
    progress.textContent = saved
      ? 'הייבוא נשמר, אך רענון המסך נכשל. יש לרענן את הדף; אין צורך לייבא שוב.'
      : error.message;
    showToast(progress.textContent, 'error');
  }
  finally { unlock(); setBusy(button, false); }
});

document.getElementById('staff-list').addEventListener('change', event => {
  const row = event.target.closest('[data-staff-row]');
  if (!row || event.target.dataset.field !== 'role') return;
  const teamSelect = row.querySelector('[data-field="team"]');
  teamSelect.disabled = !roleNeedsTeam(event.target.value);
  teamSelect.hidden = teamSelect.disabled;
  row.querySelector('[data-team-scope]').hidden = !teamSelect.disabled;
});
document.getElementById('save-staff-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true);
  try {
    await repository.replaceStaff(currentEventId, selectedStaffFromDom());
    await refreshBundle(); showToast('שיבוץ אנשי הצוות נשמר.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

document.getElementById('refresh-readiness-button').addEventListener('click', () => refreshBundle()
  .catch(error => showToast(error.message, 'error')));

document.getElementById('create-drive-files-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true, 'בודק פריסה…');
  const progress = document.getElementById('drive-progress');
  try {
    await verifyEventDriveApi();
    const targets = [
      ...teamIds().map(team => ({ id:`team-${team}`, type:'ensure_team_sheet', team })),
      ...activeStaff().filter(member => member.role === ROLES.EVALUATOR).map(member => ({
        id:`evaluator-${member.uid}`, type:'ensure_evaluator_sheet', uid:member.uid,
        name:member.displayName, team:member.team
      }))
    ];
    let completed = 0;
    for (const target of targets) {
      progress.textContent = `יוצר קובץ ${completed + 1} מתוך ${targets.length}…`;
      try {
        const data = await postToSheets({ ...target, eventId:currentEventId, eventName:bundle.event.name });
        await repository.saveArtifact(currentEventId, target.id, {
          status:ARTIFACT_STATUSES.READY, fileId:data.fileId, url:data.url, message:data.warning || ''
        });
      } catch (error) {
        await repository.saveArtifact(currentEventId, target.id, {
          status:ARTIFACT_STATUSES.FAILED, message:error.message
        });
      }
      completed += 1;
    }
    progress.textContent = `הבדיקה הסתיימה: ${completed} יעדים.`;
    await refreshBundle();
  } catch (error) { progress.textContent = error.message; showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

document.getElementById('activate-event-button').addEventListener('click', async event => {
  const button = event.currentTarget;
  setBusy(button, true, 'מפעיל…');
  try {
    let state = readiness();
    if (!state.canActivate) throw new Error(state.blockers[0]);
    if (state.warnings.length && !confirm(`קיימות ${state.warnings.length} אזהרות שאינן חוסמות. להפעיל את האירוע בכל זאת?`)) return;
    if (bundle.schedule?.draftRevision || !bundle.publishedSchedule) {
      await scheduleRepository.publishDraft({
        eventId:currentEventId,
        expectedPublishedRevision:Number(bundle.publishedSchedule?.revision || 0),
        expectedDraftRevision:Number(bundle.schedule?.draftRevision || 0),
        stationIdsByTeam:Object.fromEntries(teamIds().map(team => [team, Object.keys(stationMapForTeam(team))]))
      });
      await refreshBundle({ render:false });
      state = readiness();
    }
    await repository.activate(currentEventId, state, activeStaff());
    await refreshBundle();
    showToast('האירוע הופעל והלו״ז זמין לצוותים.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

onAuthStateChanged(auth, async user => {
  if (!user) { location.href = 'index.html'; return; }
  try {
    const snapshot = await getDoc(doc(db, 'users', user.uid));
    if (!snapshot.exists() || snapshot.data().role !== ROLES.ADMIN) {
      await signOut(auth); location.href = 'index.html'; return;
    }
    currentUser = { uid:user.uid, ...snapshot.data() };
    document.getElementById('setup-user').textContent = `${currentUser.name || ''} · ${roleLabel(currentUser.role)}`;
    repository = createEventSetupRepository(db, currentUser, { stationMapFactory:defaultStationMap });
    scheduleRepository = createScheduleRepository(db, currentUser);
    // שלוש קריאות בלתי תלויות — יוצאות יחד
    const [events] = await Promise.all([repository.listEvents(), loadStationTypes(), loadUsers()]);
    renderEventPicker(events);
    const requested = new URLSearchParams(location.search).get('eventId');
    if (requested) await selectEvent(requested);
    // סביבת העבודה הוסתרה בטעינה, ולכן הדפדפן לא גלל ל-# בעצמו
    if (requested) openSetupCard(initialCardId, { scroll: true });
  } catch (error) {
    showAlert('טעינת מסך ההגדרה נכשלה: ' + error.message, 'danger');
  }
});
