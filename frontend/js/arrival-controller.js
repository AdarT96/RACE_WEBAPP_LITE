import { arrivalRevision as revisionOf } from './arrival-order-model.js';

// One small queue per evaluator/round. It intentionally does not promise offline persistence.
export function createArrivalController({ raceId, repository, initial, onChange = () => {} }) {
  let confirmed = { ...initial, revision:revisionOf(initial) };
  let confirmedFromSnapshot = false;
  let ready = false, active = false, disposed = false, writing = false;
  let unsubscribe = null, generation = 0, listenerError = null;
  const queue = [];

  function state() {
    const pendingIds = queue.filter(command => command.type === 'append').map(command => command.pid);
    const order = [...confirmed.order];
    pendingIds.forEach(pid => { if (!order.includes(pid)) order.push(pid); });
    return {
      confirmed, arrival:{ ...confirmed, order }, pendingIds,
      pendingCount:queue.length, writing, ready,
      error:queue[0]?.error || listenerError,
      canMark:!disposed && ready && !listenerError && !queue[0]?.error && !queue.some(command => command.type === 'reorder'),
      canReorder:!disposed && ready && !listenerError && queue.length === 0
    };
  }
  const notify = () => { if (!disposed) onChange(state()); };
  function accept(value, fromSnapshot = false) {
    if (disposed) return;
    const next = value || initial;
    const revision = revisionOf(next);
    if (revision < revisionOf(confirmed)) return;
    if (revision === revisionOf(confirmed) && !fromSnapshot && confirmedFromSnapshot) return;
    confirmed = { ...next, revision };
    confirmedFromSnapshot = fromSnapshot;
  }
  function disconnect() {
    generation += 1;
    unsubscribe?.(); unsubscribe = null;
  }
  function releaseIfIdle() { if (!active && !queue.length && ready) disconnect(); }
  function connect() {
    if (disposed || unsubscribe) return;
    const token = ++generation;
    listenerError = null;
    unsubscribe = repository.subscribe(raceId, value => {
      if (disposed || token !== generation) return;
      accept(value, true); ready = true; listenerError = null;
      notify(); pump(); releaseIfIdle();
    }, error => {
      if (disposed || token !== generation) return;
      disconnect(); listenerError = error;
      notify();
    });
  }
  async function pump() {
    if (disposed || writing || !ready || listenerError || !queue.length || queue[0].error) return;
    writing = true;
    const command = queue[0];
    notify();
    try {
      const result = await repository.mutate(raceId, command);
      if (disposed) return;
      accept(result);
      queue.shift();
      command.resolve?.(confirmed);
    } catch (error) {
      if (disposed) return;
      // A reorder conflict needs a fresh explicit choice, never replay an old permutation.
      if (command.type === 'reorder') {
        queue.shift(); command.reject(error);
        disconnect(); ready = false; connect();
      } else command.error = error;
    } finally {
      writing = false;
      if (!disposed) { notify(); releaseIfIdle(); pump(); }
    }
  }
  return {
    state, accept,
    seed(value) { accept(value, true); ready = true; },
    activate() { active = true; connect(); notify(); },
    deactivate() { active = false; releaseIfIdle(); },
    append(participantId) {
      const pid = String(participantId);
      if (!state().canMark) return false;
      if (!confirmed.participantIds.includes(pid)) throw new Error('המועמד אינו ברשימת הסבב');
      if (confirmed.order.includes(pid) || queue.some(command => command.pid === pid)) return true;
      queue.push({ type:'append', pid });
      connect(); notify(); pump(); return true;
    },
    reorder(order, expectedRevision) {
      if (!state().canReorder) return Promise.reject(new Error('יש להמתין לשמירת הסימונים לפני שינוי סדר.'));
      return new Promise((resolve, reject) => {
        queue.push({ type:'reorder', order:[...order], expectedRevision, resolve, reject });
        connect(); notify(); pump();
      });
    },
    retry() {
      if (disposed || writing) return;
      if (queue[0]) queue[0].error = null;
      disconnect(); ready = false; connect(); notify();
    },
    dispose() {
      disposed = true; disconnect();
      queue.splice(0).forEach(command => command.reject?.(new Error('המשתמש התנתק')));
    }
  };
}
