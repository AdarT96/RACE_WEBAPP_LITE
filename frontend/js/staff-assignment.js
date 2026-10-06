// =====================================================
//  staff-assignment.js — תפקיד וצוות בזמן אירוע פעיל
// =====================================================
// בזמן אירוע פעיל האפליקציה (וגם חוקי Firestore) קוראות תפקיד וצוות משיבוץ
// האירוע — events/{id}/staff/{uid} — ולא מרשומת המשתמש. שינוי בפאנל המנהל
// חייב לעדכן את שניהם, ואפליקציה פתוחה צריכה לדעת שהשיבוץ שלה השתנה.

import { ROLES, roleLabel, roleNeedsTeam } from './roles.js';
import { padScheduleTeam } from './schedule-model.js';

const STAFF_ROLES = [ROLES.OPERATOR, ROLES.EVALUATOR, ROLES.FORMATION_COMMANDER];

// השדות לעדכון במסמך הסגל כשהמנהל משנה תפקיד או צוות, או null כשאין מה
// לעדכן בו (המשתמש אינו משובץ, או הופך למנהל — מנהל אינו נקרא מהסגל).
// change: { role?, team? } — מפתח שלא נשלח נשאר כפי שהוא בשיבוץ.
// fallbackTeam: צוות מרשומת המשתמש, למעבר מתפקיד ללא צוות לתפקיד עם צוות.
export function staffPatchForUserChange(staff, change = {}, fallbackTeam = null) {
  if (!staff || staff.active === false) return null;
  const role = 'role' in change ? change.role : staff.role;
  if (role === ROLES.ADMIN) return null;
  if (!STAFF_ROLES.includes(role)) throw new Error('התפקיד אינו נתמך בסגל האירוע.');
  if (!roleNeedsTeam(role)) return { role, team: '' };
  const team = 'team' in change
    ? padScheduleTeam(change.team)
    : padScheduleTeam(staff.team) || padScheduleTeam(fallbackTeam);
  if (!team) {
    throw new Error('המשתמש משובץ באירוע הפעיל ולכן חייב צוות. בחר צוות, או הסר אותו מהסגל בהגדרת האירוע.');
  }
  return { role, team };
}

// האם השיבוץ החי שונה ממה שהאפליקציה נטענה איתו. מחזיר הודעה למשתמש או null.
export function staffAssignmentChange(current = {}, staff = null) {
  if (!staff || staff.active === false) {
    return { kind: 'removed', message: 'השיבוץ שלך לאירוע הוסר — לחץ לרענון' };
  }
  if (staff.role !== current.role) {
    return { kind: 'role', message: `התפקיד שלך עודכן ל${roleLabel(staff.role)} — לחץ לרענון` };
  }
  if (roleNeedsTeam(staff.role) && Number(staff.team) !== Number(current.team)) {
    return { kind: 'team', message: `הצוות שלך עודכן לצוות ${Number(staff.team)} — לחץ לרענון` };
  }
  return null;
}
