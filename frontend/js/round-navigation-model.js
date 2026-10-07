export function viewedRoundId(rounds, previousId, followLatest = false) {
  if (!rounds.length) return null;
  if (!followLatest && rounds.some(round => round.id === previousId)) return previousId;
  return rounds[rounds.length - 1].id;
}
