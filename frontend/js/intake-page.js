// =====================================================
//  intake-page.js — מסך קליטת מועמדים (שלישות)
// =====================================================
// תזמור בלבד: הכללים ב־intake-model.js והכתיבה ב־intake-repository.js.
// סדר הטעינה: הטופס מוצג מיד (גם לפני שיש צוותים — "כללי" תמיד זמין),
// והרשימה נטענת אחריו. כתיבה לעולם אינה ממתינה לטעינת רקע ולעולם אינה
// נשענת על המטמון: כל שמירה היא טרנזקציה שקוראת מהשרת.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import { doc, getDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { CLEARANCE_LABELS, clearanceStatusLabel, padTeam } from './formation-operations-model.js';
import {
  UNASSIGNED_TEAM, buildIntakeRoster, filterIntakeRoster, intakeErrorMessage, intakeTeamLabel,
  maxParticipantNumber, moveBlockedMessage, nationalIdOwner, prepareIntakeProfile
} from './intake-model.js';
import { IntakeMoveBlockedError, createIntakeRepository } from './intake-repository.js';
import { ROLES, canManageIntake, destinationForRole, roleLabel } from './roles.js';
import { resolveActiveUserContext } from './active-user-context.js';
import { createForegroundGate, markLoad } from './load-priority.js';
import { mountMessageCenter } from './message-center.js';
import { activeEventIdFromPointer } from './messages-model.js';
import { openFirestore, signOutAndClearCache, getDocPatiently } from './firestore-cache.js';

const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = openFirestore(firebaseApp);

const PAGE_SIZE = 60;
const EVENT_KEY = 'lite:intakeEvent';
const TEAM_KEY = 'lite:intakeTeam';

let currentUser = null;
let repository = null;
let currentEvent = null;
let unsubscribeRoster = null;
let unsubscribePointer = null;
let teams = [];
let candidates = [];
let unassigned = [];
let synced = { candidates: false, unassigned: false };
let roster = [];
let expandedKey = '';
let visibleCount = PAGE_SIZE;
let busy = 0;

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const storage = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch (_) { return ''; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* לא קריטי */ } }
};

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

function showAlert(message, type = 'warning') {
  const element = $('page-alert');
  element.className = `alert alert-${type}`;
  element.textContent = message;
  element.hidden = !message;
}

window.addEventListener('beforeunload', event => {
  if (!busy) return;
  event.preventDefault();
  event.returnValue = '';
});

// ── טופס ──────────────────────────────────────────────

function renderSegmented(container, name, selected = 0) {
  container.innerHTML = Object.entries(CLEARANCE_LABELS).map(([value, label]) =>
    `<label><input type="radio" name="${name}" value="${value}" ${Number(value) === Number(selected) ? 'checked' : ''}>` +
    `<span>${escapeHtml(label)}</span></label>`).join('');
}

function segmentedValue(name, scope = document) {
  return scope.querySelector(`input[name="${name}"]:checked`)?.value ?? '0';
}

function activeTeamIds() {
  return teams.filter(team => team.active !== false).map(team => padTeam(team.id)).filter(Boolean)
    .sort((left, right) => Number(left) - Number(right));
}

function teamOptions(selected, { exclude = null } = {}) {
  const values = [UNASSIGNED_TEAM, ...activeTeamIds()].filter(value => value !== exclude);
  return values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(intakeTeamLabel(value))}</option>`).join('');
}

function renderTeamSelect() {
  const select = $('field-team');
  const remembered = select.value || storage.get(`${TEAM_KEY}:${currentEvent?.id || ''}`);
  const selected = [UNASSIGNED_TEAM, ...activeTeamIds()].includes(remembered) ? remembered : UNASSIGNED_TEAM;
  select.innerHTML = teamOptions(selected);
  const filter = $('filter');
  const current = filter.value || 'all';
  filter.innerHTML = `<option value="all">כל המועמדים</option><option value="unassigned">כללי (ללא צוות)</option>` +
    activeTeamIds().map(team => `<option value="${team}">${escapeHtml(intakeTeamLabel(team))}</option>`).join('');
  filter.value = [...filter.options].some(option => option.value === current) ? current : 'all';
}

function formValues() {
  return {
    fullName: $('field-fullName').value,
    nationalId: $('field-nationalId').value,
    emergencyContactPhone: $('field-emergencyContactPhone').value,
    doctorClearance: segmentedValue('new-doctor'),
    medicClearance: segmentedValue('new-medic')
  };
}

function resetForm() {
  $('field-fullName').value = '';
  $('field-nationalId').value = '';
  $('field-emergencyContactPhone').value = '';
  renderSegmented($('field-doctorClearance'), 'new-doctor');
  renderSegmented($('field-medicClearance'), 'new-medic');
  $('form-error').hidden = true;
  $('field-fullName').focus();
}

function showFormError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = !message;
}

function duplicateIdMessage(profile, exceptKey = '') {
  const owner = nationalIdOwner(roster, profile.nationalId, exceptKey);
  return owner ? `תעודת הזהות כבר רשומה למועמד ${owner.participantId} (${intakeTeamLabel(owner.team)}).` : '';
}

// בודק לפני שליחה: אותם כללים כמו בייבוא, ותעודת זהות שכבר רשומה באירוע.
function validateProfile(values, exceptKey = '') {
  const { profile, errors } = prepareIntakeProfile(values);
  if (errors.length) return errors.join('\n');
  return duplicateIdMessage(profile, exceptKey);
}

// בדיקה מיידית בזמן ההקלדה מול הרשימה שכבר נטענה בדף (בלי שרת).
// השרת ממשיך לבדוק בשמירה.
let duplicateIdShown = false;
function checkDuplicateIdWhileTyping() {
  const { profile, errors } = prepareIntakeProfile({ ...formValues(), fullName: 'x' });
  const message = errors.length ? '' : duplicateIdMessage(profile);
  if (message) { duplicateIdShown = true; showFormError(message); }
  else if (duplicateIdShown) { duplicateIdShown = false; showFormError(''); }
}

function knownMaxNumber() {
  // רמז בלבד, ורק כשהמנויים כבר מסונכרנים עם השרת. בלעדיו המאגר סורק את השרת.
  return synced.candidates && synced.unassigned ? maxParticipantNumber(candidates, unassigned) : null;
}

async function saveNewCandidate(event) {
  event.preventDefault();
  if (!currentEvent || !repository) return;
  const values = formValues();
  const problem = validateProfile(values);
  if (problem) { showFormError(problem); return; }
  const team = $('field-team').value;
  const button = $('save-button');
  button.disabled = true;
  button.textContent = 'שומר ומקצה מספר…';
  busy += 1;
  try {
    const result = await repository.createCandidate(currentEvent.id, values, team, { knownMax: knownMaxNumber() });
    storage.set(`${TEAM_KEY}:${currentEvent.id}`, team);
    $('result-number').textContent = result.participantId;
    $('result-caption').textContent = `${values.fullName.trim().replace(/\s+/g, ' ')} · ${intakeTeamLabel(result.team)}`;
    $('result').hidden = false;
    resetForm();
  } catch (error) {
    showFormError(intakeErrorMessage(error));
  } finally {
    busy -= 1;
    button.disabled = !currentEvent;
    button.textContent = 'שמור וקבל מספר';
  }
}

// ── רשימה ─────────────────────────────────────────────

function rebuildRoster() {
  roster = buildIntakeRoster({ teams, candidates, unassigned });
  renderList();
}

function itemEditor(row) {
  const key = escapeHtml(row.key);
  const value = text => (text === '0' ? '' : escapeHtml(text));
  return `<div class="intake-item-body" data-editor="${key}">
    <label class="intake-field">שם מלא
      <input class="form-input" data-field="fullName" maxlength="80" value="${value(row.fullName)}"></label>
    <div class="intake-row">
      <label class="intake-field">תעודת זהות
        <input class="form-input" data-field="nationalId" inputmode="numeric" maxlength="12" dir="ltr" value="${value(row.nationalId)}"></label>
      <label class="intake-field">טלפון חירום
        <input class="form-input" data-field="emergencyContactPhone" inputmode="tel" maxlength="20" dir="ltr" value="${value(row.emergencyContactPhone)}"></label>
    </div>
    <div class="intake-field">כשירות רופא<div class="segmented" data-segmented="doctor"></div></div>
    <div class="intake-field">כשירות חובש<div class="segmented" data-segmented="medic"></div></div>
    <div class="alert alert-danger intake-error" data-error hidden></div>
    <button class="btn btn-primary intake-save" type="button" data-action="save" data-key="${key}">שמור פרטים</button>
    <div class="intake-move">
      <label class="intake-field">${row.team ? 'העברה' : 'שיבוץ לצוות'}
        <select class="form-select" data-field="moveTarget">${teamOptions(row.team ? UNASSIGNED_TEAM : activeTeamIds()[0] ?? UNASSIGNED_TEAM, { exclude: row.team })}</select></label>
      <button class="btn btn-ghost" type="button" data-action="move" data-key="${key}" style="min-height:46px">${row.team ? 'העבר' : 'שבץ'}</button>
    </div>
    <p class="intake-note">${row.team
      ? 'העברה מצוות אפשרית רק כל עוד למועמד אין נתונים (סבבים, שינוי מצב או המלצת נשירה).'
      : 'מועמד כללי אינו משתתף בסבבים עד שישובץ לצוות.'}</p>
  </div>`;
}

function renderList() {
  const query = $('search').value;
  const filter = $('filter').value || 'all';
  const rows = filterIntakeRoster(roster, { query, team: filter });
  const generalCount = roster.filter(row => !row.team).length;
  $('list-count').textContent = `${rows.length} מתוך ${roster.length} מועמדים · ${generalCount} כלליים (ללא צוות)`;
  const shown = rows.slice(0, visibleCount);
  if (expandedKey && !shown.some(row => row.key === expandedKey)) {
    const expandedRow = rows.find(row => row.key === expandedKey);
    if (expandedRow) shown.unshift(expandedRow); else expandedKey = '';
  }
  const list = $('candidate-list');
  // עורך פתוח שהמשתמש מקליד בו אינו נבנה מחדש בעדכון זמן אמת
  const openEditor = list.querySelector('[data-editor]');
  if (openEditor && openEditor.contains(document.activeElement) && expandedKey &&
      openEditor.dataset.editor === expandedKey && shown.some(row => row.key === expandedKey)) {
    return;
  }
  list.innerHTML = shown.map(row => {
    const expanded = row.key === expandedKey;
    const name = row.fullName && row.fullName !== '0' ? row.fullName : 'שם לא הוזן';
    const details = [
      row.nationalId !== '0' ? `ת״ז ${row.nationalId}` : 'ת״ז חסרה',
      `רופא: ${clearanceStatusLabel(row.doctorClearance)}`, `חובש: ${clearanceStatusLabel(row.medicClearance)}`
    ].join(' · ');
    const badge = row.team
      ? `<span class="badge ${row.teamActive ? 'badge-info' : 'badge-muted'}">${escapeHtml(intakeTeamLabel(row.team))}${row.teamActive ? '' : ' (הוסר)'}</span>`
      : '<span class="badge badge-warning">כללי</span>';
    return `<div class="intake-item">
      <button class="intake-item-head" type="button" data-action="toggle" data-key="${escapeHtml(row.key)}" aria-expanded="${expanded}">
        <span class="num">${escapeHtml(row.participantId)}</span>
        <span class="name">${escapeHtml(name)}<small>${escapeHtml(details)}</small></span>
        ${badge}
      </button>
      ${expanded ? itemEditor(row) : ''}
    </div>`;
  }).join('') || `<p class="intake-note">${roster.length ? 'לא נמצאו מועמדים מתאימים.' : 'עדיין אין מועמדים באירוע.'}</p>`;
  const editor = list.querySelector('[data-editor]');
  if (editor) {
    const row = roster.find(item => item.key === expandedKey);
    renderSegmented(editor.querySelector('[data-segmented="doctor"]'), 'edit-doctor', row.doctorClearance);
    renderSegmented(editor.querySelector('[data-segmented="medic"]'), 'edit-medic', row.medicClearance);
  }
  $('show-more').hidden = rows.length <= visibleCount;
}

function editorFor(key) {
  return [...$('candidate-list').querySelectorAll('[data-editor]')].find(element => element.dataset.editor === key) || null;
}

function editorError(editor, message) {
  const element = editor?.querySelector('[data-error]');
  if (!element) { if (message) showToast(message, 'error'); return; }
  element.textContent = message;
  element.hidden = !message;
}

async function saveEdit(key, button) {
  const row = roster.find(item => item.key === key);
  const editor = editorFor(key);
  if (!row || !editor) return;
  const values = {
    fullName: editor.querySelector('[data-field="fullName"]').value,
    nationalId: editor.querySelector('[data-field="nationalId"]').value,
    emergencyContactPhone: editor.querySelector('[data-field="emergencyContactPhone"]').value,
    doctorClearance: segmentedValue('edit-doctor', editor),
    medicClearance: segmentedValue('edit-medic', editor)
  };
  const problem = validateProfile(values, key);
  if (problem) { editorError(editor, problem); return; }
  button.disabled = true;
  busy += 1;
  try {
    await repository.updateProfile(currentEvent.id,
      { team: row.team, participantId: row.participantId, profileRevision: row.profileRevision }, values);
    showToast(`פרטי מועמד ${row.participantId} נשמרו.`, 'success');
    expandedKey = '';
    document.activeElement?.blur?.();
    renderList();
  } catch (error) {
    editorError(editor, intakeErrorMessage(error));
  } finally {
    busy -= 1;
    button.disabled = false;
  }
}

async function moveRow(key, button) {
  const row = roster.find(item => item.key === key);
  const editor = editorFor(key);
  if (!row || !editor) return;
  const target = editor.querySelector('[data-field="moveTarget"]').value;
  if (target === row.team) return;
  const name = row.fullName && row.fullName !== '0' ? ` (${row.fullName})` : '';
  button.disabled = true;
  button.textContent = 'בודק…';
  busy += 1;
  try {
    // בדיקה מוקדמת כדי לא לבקש אישור להעברה שתיחסם. ההעברה עצמה בודקת שוב.
    const reasons = row.team
      ? await repository.dataReasons(currentEvent.id, row, { eventStatus: currentEvent.status }) : [];
    if (reasons.length) throw new IntakeMoveBlockedError(reasons);
    if (!confirm(`להעביר את מועמד ${row.participantId}${name} מ${intakeTeamLabel(row.team)} ל${intakeTeamLabel(target)}?`)) return;
    await repository.moveCandidate(currentEvent.id, { participantId: row.participantId, from: row.team, to: target },
      { eventStatus: currentEvent.status });
    showToast(`מועמד ${row.participantId} הועבר ל${intakeTeamLabel(target)}.`, 'success');
    expandedKey = '';
    document.activeElement?.blur?.();
    renderList();
  } catch (error) {
    editorError(editor, error instanceof IntakeMoveBlockedError ? moveBlockedMessage(error.reasons) : intakeErrorMessage(error));
  } finally {
    busy -= 1;
    button.disabled = false;
    button.textContent = row.team ? 'העבר' : 'שבץ';
  }
}

$('candidate-list').addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const key = control.dataset.key;
  if (control.dataset.action === 'toggle') {
    expandedKey = expandedKey === key ? '' : key;
    document.activeElement?.blur?.();
    renderList();
  } else if (control.dataset.action === 'save') saveEdit(key, control);
  else if (control.dataset.action === 'move') moveRow(key, control);
});
$('search').addEventListener('input', () => { visibleCount = PAGE_SIZE; renderList(); });
$('filter').addEventListener('change', () => { visibleCount = PAGE_SIZE; renderList(); });
$('show-more').addEventListener('click', () => { visibleCount += PAGE_SIZE; renderList(); });
$('intake-form').addEventListener('submit', saveNewCandidate);
$('field-nationalId').addEventListener('input', checkDuplicateIdWhileTyping);
// Enter בשדה טקסט עובר לשדה הבא ולא שולח בטעות לפני שהטופס מולא
['field-fullName', 'field-nationalId', 'field-emergencyContactPhone'].forEach((id, index, ids) => {
  $(id).addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (ids[index + 1]) $(ids[index + 1]).focus();
    else $(id).blur();
  });
});
// הודעות פנימיות הן עבודת רקע: המאזין מתחיל אחרי שמסך הקליטה מוכן.
const foreground = createForegroundGate();
let messageCenter = null;

$('logout-button').addEventListener('click', async () => {
  if (busy && !confirm('שמירה עדיין בתהליך. להתנתק בכל זאת?')) return;
  messageCenter?.dispose();
  messageCenter = null;
  await signOutAndClearCache(auth, db);
  location.href = 'index.html';
});

// ── אירוע ─────────────────────────────────────────────

function attachEvent(event) {
  unsubscribeRoster?.();
  currentEvent = event;
  teams = []; candidates = []; unassigned = []; synced = { candidates: false, unassigned: false };
  expandedKey = '';
  storage.set(EVENT_KEY, event.id);
  $('event-name').textContent = event.name || event.id;
  $('event-status').textContent = event.status === 'active' ? 'אירוע פעיל' : 'טיוטה — האירוע עדיין לא הופעל';
  $('save-button').disabled = false;
  renderTeamSelect();
  rebuildRoster();
  const failed = (error, name) => showAlert(`טעינת ${name === 'teams' ? 'הצוותים' : 'המועמדים'} נכשלה: ${intakeErrorMessage(error)}`, 'danger');
  unsubscribeRoster = repository.subscribeRoster(event.id, {
    onTeams: rows => { teams = rows; renderTeamSelect(); rebuildRoster(); markLoad('intake teams'); },
    onCandidates: (rows, meta) => { candidates = rows; synced.candidates = !meta.fromCache; rebuildRoster(); },
    onUnassigned: (rows, meta) => { unassigned = rows; synced.unassigned = !meta.fromCache; rebuildRoster(); },
    onError: failed
  });
}

function noEvent(message) {
  unsubscribeRoster?.();
  currentEvent = null;
  $('event-name').textContent = 'אין אירוע פתוח לקליטה';
  $('event-status').textContent = message;
  $('save-button').disabled = true;
}

// אירוע פעיל — תמיד הוא. אחרת בוחרים בין טיוטות (וזוכרים את הבחירה במכשיר).
async function chooseEvent(pointer) {
  const activeId = pointer?.status === 'active' ? String(pointer.eventId || '') : '';
  const select = $('event-select');
  if (activeId) {
    select.hidden = true;
    const event = await repository.getEvent(activeId);
    if (event && ['draft', 'active'].includes(event.status)) { attachEvent(event); return; }
  }
  const events = (await repository.listOpenEvents()).filter(event => !activeId || event.id === activeId);
  if (!events.length) { noEvent('המנהל צריך ליצור אירוע (טיוטה) לפני הקליטה.'); return; }
  const remembered = storage.get(EVENT_KEY);
  const initial = events.find(event => event.id === remembered) || events[0];
  select.innerHTML = events.map(event => `<option value="${escapeHtml(event.id)}" ${event.id === initial.id ? 'selected' : ''}>` +
    `${escapeHtml(event.name || event.id)} · ${event.status === 'active' ? 'פעיל' : 'טיוטה'}</option>`).join('');
  select.hidden = events.length < 2;
  select.onchange = () => {
    if (busy) { showToast('ממתין לסיום השמירה…', 'info'); select.value = currentEvent?.id || ''; return; }
    const next = events.find(event => event.id === select.value);
    if (next) attachEvent(next);
  };
  attachEvent(initial);
}

// אירוע שהופעל או נסגר בזמן העבודה: מבקשים רענון במקום להמשיך לכתוב לאירוע הלא נכון.
function watchPointer(initialPointer) {
  const initialId = initialPointer?.status === 'active' ? String(initialPointer.eventId || '') : '';
  unsubscribePointer?.();
  unsubscribePointer = onSnapshot(doc(db, 'settings', 'activeEvent'), snapshot => {
    const pointer = snapshot.exists() ? snapshot.data() : null;
    const activeId = pointer?.status === 'active' ? String(pointer.eventId || '') : '';
    if (activeId !== initialId) showAlert('האירוע הפעיל השתנה. רענן את הדף כדי להמשיך בקליטה באירוע הנכון.', 'warning');
  }, () => { /* הקריאה הראשונית כבר הצליחה; אין מה להודיע */ });
}

renderSegmented($('field-doctorClearance'), 'new-doctor');
renderSegmented($('field-medicClearance'), 'new-medic');
$('field-team').innerHTML = teamOptions(UNASSIGNED_TEAM);

onAuthStateChanged(auth, async user => {
  if (!user) { messageCenter?.dispose(); messageCenter = null; location.href = 'index.html'; return; }
  markLoad('auth ready');
  try {
    const pointerRead = getDocPatiently(doc(db, 'settings', 'activeEvent'));
    pointerRead.catch(() => {});
    const snapshot = await getDocPatiently(doc(db, 'users', user.uid));
    const rawProfile = snapshot.exists() ? snapshot.data() : null;
    const profile = rawProfile ? await resolveActiveUserContext(db, user.uid, rawProfile, { pointerRead }) : null;
    markLoad('profile resolved');
    if (!profile || (!profile.approved && profile.role !== ROLES.ADMIN)) {
      await signOutAndClearCache(auth, db); location.href = 'index.html'; return;
    }
    if (profile.eventAccess === false) {
      showAlert('המשתמש אינו משובץ בסגל האירוע הפעיל. פנה למנהל.', 'danger');
      noEvent('אין הרשאה לאירוע הפעיל.');
      return;
    }
    if (!canManageIntake(profile.role)) { location.href = destinationForRole(profile.role); return; }
    currentUser = { ...profile, uid: user.uid };
    repository = createIntakeRepository(db, currentUser);
    $('intake-user').textContent = `${currentUser.name || ''} · ${roleLabel(currentUser.role)}`;
    if (currentUser.role !== ROLES.ADJUTANT) {
      $('back-link').href = destinationForRole(currentUser.role);
      $('back-link').textContent = currentUser.role === ROLES.ADMIN ? 'פאנל מנהל' : 'דשבורד';
      $('back-link').hidden = false;
    }
    const pointer = await pointerRead.then(item => (item.exists() ? item.data() : null), () => null);
    messageCenter?.dispose();
    messageCenter = mountMessageCenter({
      db, user: { uid: user.uid, name: currentUser.name }, role: currentUser.role,
      anchor: document.querySelector('.navbar-actions'), gate: foreground,
      eventId: activeEventIdFromPointer(pointer)
    });
    await chooseEvent(pointer);
    markLoad('intake ready');
    foreground.release();
    watchPointer(pointer);
  } catch (error) {
    showAlert('טעינת מסך הקליטה נכשלה: ' + intakeErrorMessage(error), 'danger');
  }
});
