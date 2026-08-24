export const ROLES = Object.freeze({
  ADMIN: 'admin',
  OPERATOR: 'operator',
  EVALUATOR: 'evaluator',
  FORMATION_COMMANDER: 'formation_commander'
});

export const ROLE_LABELS = Object.freeze({
  [ROLES.ADMIN]: 'מנהל',
  [ROLES.OPERATOR]: 'מפק״צ',
  [ROLES.EVALUATOR]: 'מעריך',
  [ROLES.FORMATION_COMMANDER]: 'מפקד הגיבוש'
});

export function roleLabel(role) {
  return ROLE_LABELS[String(role || '')] || String(role || '');
}

export function isKnownRole(role) {
  return Object.values(ROLES).includes(String(role || ''));
}

export function roleNeedsTeam(role) {
  return [ROLES.OPERATOR, ROLES.EVALUATOR].includes(String(role || ''));
}

export function canControlSession(role) {
  return String(role || '') === ROLES.OPERATOR;
}

export function canEvaluate(role) {
  return [ROLES.EVALUATOR, ROLES.ADMIN].includes(String(role || ''));
}

export function canRecommendDropout(role) {
  return String(role || '') === ROLES.OPERATOR;
}

export function canManageFormation(role) {
  return [ROLES.FORMATION_COMMANDER, ROLES.ADMIN].includes(String(role || ''));
}

export function destinationForRole(role) {
  if (role === ROLES.ADMIN) return 'admin.html';
  if (role === ROLES.FORMATION_COMMANDER) return 'commander.html';
  if ([ROLES.OPERATOR, ROLES.EVALUATOR].includes(role)) return 'app.html';
  return 'index.html';
}
