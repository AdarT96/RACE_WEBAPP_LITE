import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import {
  collection, doc, getDoc, getFirestore, onSnapshot, query, where
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { isSessionEffectivelyRunning } from './session-policy.js';
import { EVALUATION_SCHEMA_VERSION } from './evaluation-model.js';
import {
  CANDIDATE_STATUSES, DROPOUT_REASONS, buildFormationDashboardSnapshot,
  clearanceStatusLabel, dropoutReasonLabel
} from './formation-operations-model.js';
import { createFormationOperationsRepository } from './formation-operations-repository.js';
import { ROLES, canManageFormation } from './roles.js';

const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let currentUser = null;
let repository = null;
let eventId = '';
let eventData = null;
let teams = [];
let candidates = [];
let recommendations = [];
let races = [];
let eventSubscriptions = [];
let activeEventSubscription = null;
let stationTypesSubscription = null;
let refreshTimer = null;
let pendingStatusTarget = null;
let pendingIdentityTarget = null;
let expandedTeam = '';
let latestDashboardSnapshot = null;
let effectiveRaceSignature = '';
let stationTypes = { ...(window.DEFAULT_STATION_TYPES || {}) };

const text = (id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};
const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function clearEventSubscriptions() {
  eventSubscriptions.forEach(unsubscribe => unsubscribe());
  eventSubscriptions = [];
  eventId = '';
  eventData = null;
  teams = [];
  candidates = [];
  recommendations = [];
  races = [];
}

function showBlocking(message) {
  const block = document.getElementById('blocking-message');
  block.textContent = message;
  block.hidden = false;
  document.getElementById('dashboard-content').hidden = true;
}

function subscribeToActiveEvent() {
  activeEventSubscription?.();
  activeEventSubscription = onSnapshot(doc(db, 'settings', 'activeEvent'), snapshot => {
    const pointer = snapshot.exists() ? snapshot.data() : null;
    const nextEventId = pointer?.status === 'active' ? String(pointer.eventId || '') : '';
    if (!nextEventId) {
      clearEventSubscriptions();
      text('event-name', 'דשבורד גיבוש');
      text('event-status', 'אין אירוע פעיל');
      showBlocking('מנהל המערכת צריך ליצור אירוע פעיל לפני שימוש בדשבורד.');
      return;
    }
    if (nextEventId !== eventId) attachEvent(nextEventId);
  }, error => showBlocking('לא ניתן לקרוא את האירוע הפעיל: ' + error.message));
}

function attachEvent(nextEventId) {
  clearEventSubscriptions();
  eventId = nextEventId;
  const fail = label => error => showBlocking(`טעינת ${label} נכשלה: ${error.message}`);
  eventSubscriptions.push(onSnapshot(doc(db, 'events', eventId), snapshot => {
    if (!snapshot.exists() || snapshot.data().status !== 'active') {
      showBlocking('האירוע אינו פעיל עוד.');
      return;
    }
    eventData = { id: snapshot.id, ...snapshot.data() };
    renderDashboard();
  }, fail('האירוע')));
  eventSubscriptions.push(onSnapshot(collection(db, 'events', eventId, 'teams'), snapshot => {
    teams = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderDashboard();
  }, fail('הצוותים')));
  eventSubscriptions.push(onSnapshot(collection(db, 'events', eventId, 'candidates'), snapshot => {
    candidates = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderDashboard();
  }, fail('המועמדים')));
  eventSubscriptions.push(onSnapshot(collection(db, 'events', eventId, 'dropoutRecommendations'), snapshot => {
    recommendations = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderDashboard();
  }, fail('ההמלצות')));
  eventSubscriptions.push(onSnapshot(query(collection(db, 'races'),
    where('eventId', '==', eventId),
    where('evaluationSchemaVersion', '==', EVALUATION_SCHEMA_VERSION)), snapshot => {
    races = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderDashboard();
  }, fail('מצב התחנות')));
}

function stationName(teamRow) {
  if (!teamRow.station) return '—';
  const typeId = teamRow.stationMap?.[teamRow.station] || window.DEFAULT_STATION_ORDER?.[Number(teamRow.station) - 1];
  return stationTypes[typeId]?.name || `תחנה ${Number(teamRow.station)}`;
}

function statusLabel(status) {
  return ({ running: 'פעילה', stopped: 'נעצרה', not_started: 'טרם התחילה' })[status] || '—';
}

function renderTeams(snapshot) {
  const body = document.getElementById('teams-table');
  if (!snapshot.teams.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-panel">אין צוותים באירוע.</td></tr>';
    return;
  }
  if (expandedTeam && !snapshot.teams.some(team => team.team === expandedTeam)) expandedTeam = '';
  body.innerHTML = snapshot.teams.map(team => {
    const expanded = team.team === expandedTeam;
    const candidateRows = team.candidates.slice().sort((a, b) =>
      a.participantId.localeCompare(b.participantId, 'he', { numeric: true })).map(candidate => {
      const withdrawn = candidate.status === CANDIDATE_STATUSES.WITHDRAWN;
      const editIdentity = currentUser?.role === ROLES.ADMIN
        ? `<button class="btn btn-ghost" onclick="openIdentityModal('${escapeHtml(candidate.team)}','${escapeHtml(candidate.participantId)}')">ערוך פרטים</button>` : '';
      return `<div class="team-candidate-row">
        <div class="team-candidate-primary">
          <strong>מועמד ${escapeHtml(candidate.participantId)}</strong>
          <span>${escapeHtml(candidate.firstName || 'שם לא הוזן')}</span>
        </div>
        <div class="team-candidate-profile">
          <div class="team-candidate-id"><span>תעודת זהות</span><strong>${escapeHtml(candidate.nationalId || 'לא הוזנה')}</strong></div>
          <div><span>איש קשר חירום</span>${candidate.emergencyContactPhone
            ? `<a href="tel:${escapeHtml(candidate.emergencyContactPhone)}" dir="ltr">${escapeHtml(candidate.emergencyContactPhone)}</a>`
            : '<strong>לא הוזן</strong>'}</div>
          <div><span>כשירות</span><strong>רופא: ${escapeHtml(clearanceStatusLabel(candidate.doctorClearance))} · חובש: ${escapeHtml(clearanceStatusLabel(candidate.medicClearance))}</strong></div>
        </div>
        <div><span class="formation-status ${withdrawn ? 'withdrawn' : 'active'}">${withdrawn ? 'נשר' : 'פעיל'}</span></div>
        <div>${withdrawn ? escapeHtml(candidate.reasonLabel) : candidate.hasOpenRecommendation
          ? '<span class="updated-at">המלצה ממתינה</span>' : '—'}</div>
        <div class="candidate-action">${withdrawn
          ? `<button class="btn btn-ghost" onclick="reactivateCandidate('${escapeHtml(candidate.team)}','${escapeHtml(candidate.participantId)}')">החזר לפעילות</button>`
          : candidate.hasOpenRecommendation
            ? '<span class="updated-at">טיפול באזור ההמלצות</span>'
            : `<button class="btn btn-danger" onclick="openWithdrawModal('${escapeHtml(candidate.team)}','${escapeHtml(candidate.participantId)}')">סמן נשירה</button>`}${editIdentity}</div>
      </div>`;
    }).join('');
    return `
    <tr class="team-summary-row">
      <td data-label="צוות"><button class="team-toggle" type="button" aria-expanded="${expanded}"
          onclick="toggleTeam('${escapeHtml(team.team)}')"><span aria-hidden="true">${expanded ? '▾' : '◂'}</span> צוות ${Number(team.team)}</button></td>
      <td data-label="פעילים">${team.active} / ${team.total}</td>
      <td data-label="נשרו">${team.withdrawn}</td>
      <td data-label="תחנה">${escapeHtml(stationName(team))}</td>
      <td data-label="סבב">${team.round || '—'}</td>
      <td data-label="מצב"><span class="formation-status ${escapeHtml(team.raceStatus)}">${statusLabel(team.raceStatus)}</span></td>
    </tr>
    ${expanded ? `<tr class="team-details-row"><td colspan="6" class="team-details-cell">
      <div class="team-candidate-heading"><strong>מועמדי צוות ${Number(team.team)}</strong><span>${team.total} מועמדים</span></div>
      <div class="team-candidate-list">${candidateRows || '<div class="empty-panel">אין מועמדים בצוות.</div>'}</div>
    </td></tr>` : ''}`;
  }).join('');
}

window.toggleTeam = team => {
  expandedTeam = expandedTeam === String(team) ? '' : String(team);
  if (latestDashboardSnapshot) renderTeams(latestDashboardSnapshot);
};

function renderRecommendations(snapshot) {
  const container = document.getElementById('recommendations');
  if (!snapshot.openRecommendations.length) {
    container.innerHTML = '<div class="empty-panel">אין המלצות שממתינות להחלטה.</div>';
    return;
  }
  container.innerHTML = snapshot.openRecommendations.map(item => `
    <article class="recommendation-item">
      <div class="recommendation-title"><span>מועמד ${escapeHtml(item.participantId)} · ${escapeHtml(item.candidate.firstName || 'שם לא הוזן')}</span><span>צוות ${Number(item.team)}</span></div>
      <div class="recommendation-details"><strong>${escapeHtml(dropoutReasonLabel(item.reasonCode))}</strong> · ${escapeHtml(item.recommendedByName || 'מפק״צ')}${item.details ? `\n${escapeHtml(item.details)}` : ''}</div>
      <div class="recommendation-actions">
        <button class="btn btn-danger" onclick="resolveRecommendation('${escapeHtml(item.team)}','${escapeHtml(item.participantId)}','accept')">אשר נשירה</button>
        <button class="btn btn-ghost" onclick="resolveRecommendation('${escapeHtml(item.team)}','${escapeHtml(item.participantId)}','reject')">דחה</button>
      </div>
    </article>`).join('');
}

function renderReasonBars(snapshot) {
  const maximum = Math.max(1, ...Object.values(snapshot.reasonCounts));
  document.getElementById('reason-bars').innerHTML = Object.entries(DROPOUT_REASONS).map(([code, label]) => {
    const count = snapshot.reasonCounts[code] || 0;
    return `<div class="reason-row"><span>${escapeHtml(label)}</span><div class="reason-track"><div class="reason-fill" style="width:${Math.round(count / maximum * 100)}%"></div></div><strong>${count}</strong></div>`;
  }).join('');
}

window.renderDashboard = () => {
  if (!eventData) return;
  const snapshot = buildFormationDashboardSnapshot({
    event: eventData, teams, candidates, recommendations, races,
    nowMs: Date.now(), isRaceRunning: isSessionEffectivelyRunning
  });
  document.getElementById('blocking-message').hidden = true;
  document.getElementById('dashboard-content').hidden = false;
  text('event-name', eventData.name || 'אירוע גיבוש');
  text('event-status', `אירוע פעיל · ${snapshot.teams.length} צוותים`);
  text('last-updated', `עודכן ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  text('kpi-candidates', snapshot.totals.candidates);
  text('kpi-active', snapshot.totals.active);
  text('kpi-withdrawn', snapshot.totals.withdrawn);
  text('kpi-teams', snapshot.teams.length);
  text('kpi-running', snapshot.totals.teamsRunning);
  const anomalies = document.getElementById('anomalies');
  anomalies.innerHTML = snapshot.anomalies.map(message => `<div class="formation-alert">${escapeHtml(message)}</div>`).join('');
  renderTeams(snapshot);
  renderRecommendations(snapshot);
  renderReasonBars(snapshot);
  latestDashboardSnapshot = snapshot;
  effectiveRaceSignature = snapshot.teams.map(team => `${team.team}:${team.raceStatus}:${team.currentRace?.id || ''}`).join('|');
};

window.resolveRecommendation = async (team, participantId, decision) => {
  const verb = decision === 'accept' ? 'לאשר את הנשירה' : 'לדחות את ההמלצה';
  if (!confirm(`${verb} של מועמד ${participantId} מצוות ${Number(team)}?`)) return;
  try {
    await repository.resolveRecommendation(eventId, team, participantId, decision);
  } catch (error) {
    alert('הפעולה נכשלה: ' + error.message);
  }
};

window.openWithdrawModal = (team, participantId) => {
  pendingStatusTarget = { team, participantId };
  const candidate = latestDashboardSnapshot?.candidates.find(item =>
    item.team === String(team) && item.participantId === String(participantId));
  const identity = candidate?.firstName ? ` · ${candidate.firstName}` : '';
  text('status-modal-summary', `מועמד ${participantId}${identity} · צוות ${Number(team)}`);
  document.getElementById('status-reason').value = '';
  document.getElementById('status-details').value = '';
  document.getElementById('status-modal').hidden = false;
  document.getElementById('status-reason').focus();
};

window.closeStatusModal = () => {
  pendingStatusTarget = null;
  document.getElementById('status-modal').hidden = true;
};

window.openIdentityModal = (team, participantId) => {
  if (currentUser?.role !== ROLES.ADMIN) return;
  const candidate = latestDashboardSnapshot?.candidates.find(item =>
    item.team === String(team) && item.participantId === String(participantId));
  if (!candidate) return;
  pendingIdentityTarget = { team, participantId };
  text('identity-modal-summary', `מועמד ${participantId} · צוות ${Number(team)}`);
  document.getElementById('identity-first-name').value = candidate.firstName || '';
  document.getElementById('identity-national-id').value = candidate.nationalId || '';
  document.getElementById('identity-emergency-phone').value = candidate.emergencyContactPhone || '';
  document.getElementById('identity-doctor-clearance').value = candidate.doctorClearance;
  document.getElementById('identity-medic-clearance').value = candidate.medicClearance;
  document.getElementById('identity-modal').hidden = false;
  document.getElementById('identity-first-name').focus();
};

window.closeIdentityModal = () => {
  pendingIdentityTarget = null;
  document.getElementById('identity-modal').hidden = true;
};

window.confirmCandidateIdentity = async event => {
  event.preventDefault();
  if (!pendingIdentityTarget || currentUser?.role !== ROLES.ADMIN) return;
  const button = document.getElementById('identity-submit');
  button.disabled = true;
  try {
    await repository.updateCandidateProfile(
      eventId, pendingIdentityTarget.team, pendingIdentityTarget.participantId,
      {
        firstName: document.getElementById('identity-first-name').value,
        nationalId: document.getElementById('identity-national-id').value,
        emergencyContactPhone: document.getElementById('identity-emergency-phone').value,
        doctorClearance: Number(document.getElementById('identity-doctor-clearance').value),
        medicClearance: Number(document.getElementById('identity-medic-clearance').value)
      }
    );
    closeIdentityModal();
  } catch (error) {
    alert('עדכון פרטי המועמד נכשל: ' + error.message);
  } finally {
    button.disabled = false;
  }
};

window.confirmCandidateStatus = async event => {
  event.preventDefault();
  if (!pendingStatusTarget) return;
  const reason = document.getElementById('status-reason').value;
  const details = document.getElementById('status-details').value;
  if (!DROPOUT_REASONS[reason]) return;
  const button = document.getElementById('status-submit');
  button.disabled = true;
  try {
    await repository.setCandidateStatus(eventId, pendingStatusTarget.team, pendingStatusTarget.participantId,
      CANDIDATE_STATUSES.WITHDRAWN, reason, details);
    closeStatusModal();
  } catch (error) {
    alert('עדכון המועמד נכשל: ' + error.message);
  } finally {
    button.disabled = false;
  }
};

window.reactivateCandidate = async (team, participantId) => {
  const candidate = latestDashboardSnapshot?.candidates.find(item =>
    item.team === String(team) && item.participantId === String(participantId));
  const identity = candidate?.firstName ? ` (${candidate.firstName})` : '';
  if (!confirm(`להחזיר את מועמד ${participantId}${identity} מצוות ${Number(team)} לפעילות?`)) return;
  try {
    await repository.setCandidateStatus(eventId, team, participantId, CANDIDATE_STATUSES.ACTIVE);
  } catch (error) {
    alert('עדכון המועמד נכשל: ' + error.message);
  }
};

window.logout = async () => {
  await signOut(auth);
  location.href = 'index.html';
};

document.getElementById('status-modal').addEventListener('click', event => {
  if (event.target.id === 'status-modal') closeStatusModal();
});
document.getElementById('identity-modal').addEventListener('click', event => {
  if (event.target.id === 'identity-modal') closeIdentityModal();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('status-modal').hidden) closeStatusModal();
  if (event.key === 'Escape' && !document.getElementById('identity-modal').hidden) closeIdentityModal();
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    location.href = 'index.html';
    return;
  }
  try {
    const snapshot = await getDoc(doc(db, 'users', user.uid));
    const profile = snapshot.exists() ? snapshot.data() : null;
    if (!profile || (!profile.approved && profile.role !== ROLES.ADMIN) || !canManageFormation(profile.role)) {
      await signOut(auth);
      location.href = 'index.html';
      return;
    }
    currentUser = { ...profile, uid: user.uid };
    repository = createFormationOperationsRepository(db, currentUser);
    text('commander-user', currentUser.name || '');
    document.getElementById('admin-link').style.display = currentUser.role === ROLES.ADMIN ? '' : 'none';
    stationTypesSubscription?.();
    stationTypesSubscription = onSnapshot(doc(db, 'settings', 'stationTypes'), stationSnapshot => {
      const savedTypes = stationSnapshot.exists() && stationSnapshot.data()?.types && typeof stationSnapshot.data().types === 'object'
        ? stationSnapshot.data().types : {};
      stationTypes = Object.fromEntries([...new Set([
        ...Object.keys(window.DEFAULT_STATION_TYPES || {}), ...Object.keys(savedTypes)
      ])].map(typeId => [typeId, {
        ...(window.DEFAULT_STATION_TYPES?.[typeId] || {}), ...(savedTypes[typeId] || {})
      }]));
      renderDashboard();
    }, () => {
      stationTypes = { ...(window.DEFAULT_STATION_TYPES || {}) };
      renderDashboard();
    });
    subscribeToActiveEvent();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!eventData) return;
      const snapshot = buildFormationDashboardSnapshot({
        event: eventData, teams, candidates, recommendations, races,
        nowMs: Date.now(), isRaceRunning: isSessionEffectivelyRunning
      });
      const signature = snapshot.teams
        .map(team => `${team.team}:${team.raceStatus}:${team.currentRace?.id || ''}`).join('|');
      if (signature !== effectiveRaceSignature) renderDashboard();
    }, 1000);
  } catch (error) {
    showBlocking('הכניסה לדשבורד נכשלה: ' + error.message);
  }
});
