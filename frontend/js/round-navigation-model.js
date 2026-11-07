export function viewedRoundId(rounds, previousId, followLatest = false) {
  if (!rounds.length) return null;
  if (!followLatest && rounds.some(round => round.id === previousId)) return previousId;
  return rounds[rounds.length - 1].id;
}

// סבב חדש שהתחיל עכשיו: גם מעריך שצופה בסבב קודם עובר אליו. בסימולציה מעריכים
// נשארו על הסבב שהסתיים, סימנו בו הגעות, והסבב החדש נשאר ריק. רק מי שבאמצע
// גרירה של סדר ההגעה נשאר במקום (busy) — ויעבור דרך הבאנר כשיסיים.
export function shouldFollowNewRound({ previousLatestId, latestRace, busy = false }) {
  return Boolean(previousLatestId && latestRace?.id && latestRace.id !== previousLatestId &&
    latestRace.status === 'running' && !busy);
}
