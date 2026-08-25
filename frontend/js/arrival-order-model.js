export function uniqueArrivalParticipantIds(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, value) => {
    const participantId = String(value ?? '').trim();
    if (participantId && !seen.has(participantId)) {
      seen.add(participantId);
      result.push(participantId);
    }
    return result;
  }, []);
}

export function arrivalEntriesInOrder(arrival) {
  return uniqueArrivalParticipantIds(arrival?.order).map((participantId, index) => ({
    participantId,
    place:index + 1,
    finishedAt:arrival?.slotTimes?.[String(index + 1)] ?? null
  }));
}

function timestampMs(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function arrivalOrderSignature(arrival) {
  return arrivalEntriesInOrder(arrival).map(entry => {
    const time = timestampMs(entry.finishedAt);
    return `${entry.participantId}:${entry.place}:${time == null ? '' : time}`;
  }).join('|');
}

export function moveParticipantInOrder(order, participantId, targetIndex) {
  const result = uniqueArrivalParticipantIds(order);
  const from = result.indexOf(String(participantId));
  const requestedIndex = Number(targetIndex);
  if (from < 0 || result.length < 2 || !Number.isFinite(requestedIndex)) return result;
  const to = Math.max(0, Math.min(result.length - 1, Math.floor(requestedIndex)));
  if (from === to) return result;
  const [moved] = result.splice(from, 1);
  result.splice(to, 0, moved);
  return result;
}

export function arrivalWithOrder(arrival, orderedParticipantIds) {
  const currentOrder = uniqueArrivalParticipantIds(arrival?.order);
  const rawOrder = (Array.isArray(orderedParticipantIds) ? orderedParticipantIds : [])
    .map(value => String(value ?? '').trim()).filter(Boolean);
  const order = uniqueArrivalParticipantIds(orderedParticipantIds);
  const currentSet = new Set(currentOrder);
  if (rawOrder.length !== order.length || order.length !== currentOrder.length ||
      order.some(participantId => !currentSet.has(participantId))) {
    throw new Error('רשימת סדר ההגעה אינה תואמת לנתונים העדכניים');
  }
  return { ...arrival, order };
}
