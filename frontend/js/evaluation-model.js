export const EVALUATION_SCHEMA_VERSION = 2;

export const TRAITS = Object.freeze([
  { id: 'resilience', name: 'חוסן וכושר הסתגלות' },
  { id: 'activity', name: 'אקטיביות' },
  { id: 'social_intelligence', name: 'אינטליגנציה חברתית' },
  { id: 'assertiveness', name: 'אסרטיביות' },
  { id: 'analysis_judgment', name: 'ניתוח מידע ושיקול דעת' }
]);

const TRAIT_BY_ID = new Map(TRAITS.map(trait => [trait.id, trait]));
const TRAIT_ID_BY_NAME = new Map(TRAITS.map(trait => [trait.name, trait.id]));

export function traitIdFor(value) {
  const key = String(value?.id || value?.name || value || '').trim();
  if (TRAIT_BY_ID.has(key)) return key;
  return TRAIT_ID_BY_NAME.get(key) || key;
}

export function traitNameFor(value) {
  const id = traitIdFor(value);
  return TRAIT_BY_ID.get(id)?.name || String(value?.name || value || id);
}

export function normalizeScores(scores, traitAliases = {}) {
  const normalized = {};
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return normalized;
  Object.entries(scores).forEach(([key, value]) => {
    const id = String(traitAliases[key] || traitIdFor(key));
    const score = Number(value);
    if (id && Number.isInteger(score) && score >= 1 && score <= 7) normalized[id] = score;
  });
  return normalized;
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function stableLegacyNoteId(note, index = 0) {
  const source = typeof note === 'string' ? note : JSON.stringify({
    text: note?.text || '', authorUid: note?.authorUid || '', at: note?.at || 0, index
  });
  return `legacy_${hashText(source)}`;
}

export function normalizeNote(note, index = 0) {
  const value = note && typeof note === 'object' ? note : { text: String(note || '') };
  return {
    id: String(value.id || stableLegacyNoteId(value, index)),
    text: String(value.text || '').trim(),
    authorName: String(value.authorName || ''),
    authorUid: String(value.authorUid || ''),
    createdAt: Number(value.createdAt || value.at || 0) || 0,
    updatedAt: Number(value.updatedAt || value.createdAt || value.at || 0) || 0
  };
}

export function normalizeNotes(notes) {
  const seen = new Set();
  return (Array.isArray(notes) ? notes : [])
    .map(normalizeNote)
    .filter(note => note.text && !seen.has(note.id) && seen.add(note.id));
}

// שעות ההקשה (ms מאז 1970) של כל חזרה בסבב, בתחנת ספירה. מהן מחושב משך כל חזרה.
export const MAX_REP_TIMES = 300;
export function normalizeRepTimes(value) {
  return (Array.isArray(value) ? value : []).map(Number)
    .filter(time => Number.isFinite(time) && time > 0).slice(0, MAX_REP_TIMES);
}

export function normalizeAssessmentEntry(entry) {
  const measurement = entry?.measurement == null || entry?.measurement === ''
    ? null : Number(entry.measurement);
  return {
    scores: normalizeScores(entry?.scores),
    measurement: Number.isFinite(measurement) && measurement >= 0 ? measurement : null,
    repTimes: normalizeRepTimes(entry?.repTimes),
    comments: normalizeNotes(entry?.comments),
    clearedScores: Array.from(new Set((Array.isArray(entry?.clearedScores) ? entry.clearedScores : [])
      .map(traitIdFor).filter(Boolean))),
    measurementCleared: entry?.measurementCleared === true,
    hiddenCommentIds: Array.from(new Set((Array.isArray(entry?.hiddenCommentIds) ? entry.hiddenCommentIds : [])
      .map(String).filter(Boolean)))
  };
}

export function normalizeAssessment(data, evaluatorUid = '') {
  const entries = {};
  const rawEntries = data?.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)
    ? data.entries : {};
  Object.entries(rawEntries).forEach(([participantId, entry]) => {
    entries[String(participantId)] = normalizeAssessmentEntry(entry);
  });
  return {
    evaluatorUid: String(data?.evaluatorUid || evaluatorUid),
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    entries
  };
}

export function legacyEntryForParticipant(tags, participantId, evaluatorUid) {
  const tag = (Array.isArray(tags) ? tags : [])
    .find(item => String(item?.participantId) === String(participantId));
  if (!tag) return normalizeAssessmentEntry(null);
  return normalizeAssessmentEntry({
    scores: tag.scores?.[evaluatorUid] || {},
    measurement: tag.reps,
    comments: (Array.isArray(tag.comments) ? tag.comments : [])
      .filter(comment => normalizeNote(comment).authorUid === evaluatorUid)
  });
}

export function mergeAssessmentEntries(legacyEntry, privateEntry) {
  const legacy = normalizeAssessmentEntry(legacyEntry);
  const current = normalizeAssessmentEntry(privateEntry);
  const hidden = new Set(current.hiddenCommentIds);
  const comments = normalizeNotes([
    ...legacy.comments.filter(comment => !hidden.has(comment.id)),
    ...current.comments
  ]);
  const legacyScores = { ...legacy.scores };
  current.clearedScores.forEach(traitId => { delete legacyScores[traitId]; });
  return {
    scores: { ...legacyScores, ...current.scores },
    measurement: current.measurement == null && !current.measurementCleared
      ? legacy.measurement : current.measurement,
    repTimes: current.repTimes,
    comments,
    clearedScores: current.clearedScores,
    measurementCleared: current.measurementCleared,
    hiddenCommentIds: current.hiddenCommentIds
  };
}

export function assessmentEntryFor({ assessment, race, participantId, evaluatorUid }) {
  const privateEntry = assessment?.entries?.[String(participantId)];
  const legacyEntry = legacyEntryForParticipant(race?.tags, participantId, evaluatorUid);
  return mergeAssessmentEntries(legacyEntry, privateEntry);
}

function sortedRounds(races) {
  return (Array.isArray(races) ? races : []).filter(race => race?.id != null).slice()
    .sort((a, b) => Number(a.round || 0) - Number(b.round || 0) || String(a.id).localeCompare(String(b.id)));
}

// הציונים וההערות שייכים לתחנה כולה, לא לסבב: הם נשמרים במסמך ההערכה של
// הסבב הראשון בתחנה. כל סבב שומר במסמך שלו רק את המדידה שלו.
export function stationAssessmentRace(races) {
  return sortedRounds(races)[0] || null;
}

// הרשומה שהמעריך רואה בתחנה: ציונים והערות של התחנה + המדידה של הסבב `race`.
// ציונים והערות שנשמרו לפני השינוי בסבבים מאוחרים נקראים כנתון ישן מתחת
// לסבב הראשון (המאוחר גובר); מחיקה או ניקוי בסבב הראשון מסתירים גם אותם.
export function stationAssessmentEntry({ races, assessmentsByRace, race = null, participantId, evaluatorUid }) {
  const pid = String(participantId);
  const lookup = id => assessmentsByRace?.get?.(String(id)) || assessmentsByRace?.[id] || null;
  const roundEntry = round => assessmentEntryFor({
    assessment: lookup(round.id), race: round, participantId: pid, evaluatorUid
  });
  const [first, ...later] = sortedRounds(races);
  const round = race ? roundEntry(race) : null;
  const measurement = round ? round.measurement : null;
  const repTimes = round ? round.repTimes : [];
  if (!first) return { ...normalizeAssessmentEntry(null), measurement, repTimes };

  const earlier = [legacyEntryForParticipant(first.tags, pid, evaluatorUid), ...later.map(roundEntry)]
    .reduce((merged, entry) => ({
      ...merged,
      scores: { ...merged.scores, ...entry.scores },
      comments: normalizeNotes([...merged.comments, ...entry.comments])
    }), normalizeAssessmentEntry(null));
  const station = mergeAssessmentEntries(earlier, lookup(first.id)?.entries?.[pid]);
  return { ...station, measurement, repTimes };
}

// סבב שמסמך ההערכה שלו מחזיק את ההערה (לעריכה של הערה ישנה מסבב מאוחר)
export function stationNoteRaceId({ races, assessmentsByRace, participantId, noteId }) {
  const pid = String(participantId);
  const ordered = sortedRounds(races);
  const lookup = id => assessmentsByRace?.get?.(String(id)) || assessmentsByRace?.[id] || null;
  const holder = ordered.find(round => normalizeNotes(lookup(round.id)?.entries?.[pid]?.comments)
    .some(note => note.id === String(noteId)));
  return String((holder || ordered[0])?.id || '');
}

export function hasAssessmentData(entry) {
  const normalized = normalizeAssessmentEntry(entry);
  return Object.keys(normalized.scores).length > 0 ||
    normalized.measurement != null || normalized.comments.length > 0;
}

export function createNote({ text, authorUid, authorName, now = Date.now(), id } = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('לא ניתן לשמור הערה ריקה');
  const generatedId = id || (globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `note_${now}_${Math.random().toString(36).slice(2, 10)}`);
  return {
    id: String(generatedId), text: clean,
    authorUid: String(authorUid || ''), authorName: String(authorName || ''),
    createdAt: Number(now), updatedAt: Number(now)
  };
}

export function buildLegacyAssessmentBuckets(race, teamEvaluatorUids = [], traitAliases = {}) {
  const buckets = new Map();
  const ensure = (uid, participantId) => {
    if (!uid) return null;
    if (!buckets.has(uid)) buckets.set(uid, {});
    const entries = buckets.get(uid);
    const pid = String(participantId);
    entries[pid] = normalizeAssessmentEntry(entries[pid]);
    return entries[pid];
  };
  (Array.isArray(race?.tags) ? race.tags : []).forEach(tag => {
    const participantId = String(tag?.participantId || '');
    if (!participantId) return;
    Object.entries(tag?.scores || {}).forEach(([uid, scores]) => {
      const entry = ensure(uid, participantId);
      entry.scores = { ...entry.scores, ...normalizeScores(scores, traitAliases) };
    });
    (Array.isArray(tag?.comments) ? tag.comments : []).forEach((comment, index) => {
      const note = normalizeNote(comment, index);
      if (!note.authorUid) return;
      const entry = ensure(note.authorUid, participantId);
      entry.comments = normalizeNotes([...entry.comments, note]);
    });
    if (tag?.reps != null) {
      teamEvaluatorUids.forEach(uid => {
        const entry = ensure(uid, participantId);
        entry.measurement = Number(tag.reps);
      });
    }
  });
  return buckets;
}

function average(values) {
  const valid = values.map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function numericStationOrder(value) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

export function buildCandidateSummary({
  participantId, races = [], assessmentsByRace = new Map(), arrivalsByRace = new Map(),
  stationTypeForRace = () => null, evaluatorUid = ''
}) {
  const candidateId = String(participantId || '');
  const racesByStation = new Map();

  (Array.isArray(races) ? races : []).forEach(race => {
    const stationType = stationTypeForRace(race) || {};
    const stationId = String(race.station || '');
    const typeId = String(stationType.id || stationId);
    const key = `${stationId}:${typeId}`;
    if (!racesByStation.has(key)) {
      racesByStation.set(key, { key, stationId, typeId, stationType, races: [] });
    }
    racesByStation.get(key).races.push(race);
  });

  const stations = [];
  racesByStation.forEach(({ key, stationId, typeId, stationType, races: stationRaces }) => {
    const station = stationAssessmentEntry({
      races: stationRaces, assessmentsByRace, participantId: candidateId, evaluatorUid
    });
    const rounds = sortedRounds(stationRaces).flatMap(race => {
      const measurement = stationAssessmentEntry({
        races: stationRaces, assessmentsByRace, race, participantId: candidateId, evaluatorUid
      }).measurement;
      const arrival = arrivalsByRace.get?.(race.id) || arrivalsByRace[race.id] || null;
      const order = Array.isArray(arrival?.order) ? arrival.order.map(String) : [];
      const placeIndex = order.indexOf(candidateId);
      const roster = Array.isArray(race?.participantIds) ? race.participantIds.map(String) : [];
      if (!roster.includes(candidateId) && placeIndex < 0 && measurement == null) return [];
      return [{
        raceId: String(race.id), round: Number(race.round || 0), status: String(race.status || ''),
        measurement, place: placeIndex >= 0 ? placeIndex + 1 : null, placedCount: order.length
      }];
    });
    if (!rounds.length && !hasAssessmentData(station)) return;
    stations.push({
      key, stationId, typeId,
      name: String(stationType.name || `תחנה ${Number(stationId) || stationId}`),
      measure: String(stationType.measure || 'none'),
      measureLabel: String(stationType.measureLabel || 'תוצאה'),
      params: Array.isArray(stationType.params) ? stationType.params : [],
      // הסבב שבמסמך שלו נשמרים הציונים וההערות של התחנה
      assessmentRaceId: String(stationAssessmentRace(stationRaces).id),
      scores: station.scores, comments: station.comments,
      traitAverages: { ...station.scores },
      rounds
    });
  });
  stations.sort((a, b) => numericStationOrder(a.stationId) - numericStationOrder(b.stationId) || a.name.localeCompare(b.name, 'he'));

  const traitAverages = {};
  TRAITS.forEach(trait => {
    const stationMeans = stations
      .map(station => station.traitAverages[trait.id])
      .filter(value => value != null);
    const value = average(stationMeans);
    if (value != null) {
      traitAverages[trait.id] = { value, stationCount: stationMeans.length };
    }
  });

  return { participantId: candidateId, traitAverages, stations };
}
