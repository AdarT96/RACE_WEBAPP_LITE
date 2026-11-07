// =====================================================
//  event-map-model.js — מפת שטח הגיבוש: מודל טהור
// =====================================================
// תמונה אחת לאירוע, נשמרת כ-base64 בתוך מסמך Firestore
// (events/{eventId}/assets/map) — בלי Storage, וזמינה גם בלי קליטה ממטמון
// Firestore שבמכשיר. ללא Firestore ובלי DOM; החוקים בשרת הם גבול ההרשאה.

import { ROLES } from './roles.js';

export const MAP_SCHEMA_VERSION = 1;
export const MAP_ASSET_ID = 'map';
// מסמך Firestore מוגבל ל-1MiB. התמונה נדחסת בדפדפן עד שהיא נכנסת למגבלה הזו;
// החוקים מאפשרים מעט יותר כדי שלא תידחה תמונה שבדיוק על הגבול.
export const MAP_MAX_DATA_LENGTH = 700000;
export const MAP_RULES_MAX_DATA_LENGTH = 750000;
export const MAP_MAX_DIMENSION = 6000;
export const MAP_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

// מנהל — בכל אירוע שאפשר לערוך; מפקד הגיבוש — באירוע הפעיל (נאכף בחוקים).
export function canEditEventMap(role) {
  return [ROLES.ADMIN, ROLES.FORMATION_COMMANDER].includes(String(role || ''));
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateMapImage(image) {
  const errors = [];
  const data = String(image?.data || '');
  if (!MAP_MIME_TYPES.includes(String(image?.mimeType || ''))) errors.push('סוג התמונה אינו נתמך.');
  if (!data || !BASE64_PATTERN.test(data)) errors.push('התמונה פגומה.');
  else if (data.length > MAP_MAX_DATA_LENGTH) errors.push('התמונה גדולה מדי גם אחרי דחיסה.');
  for (const key of ['width', 'height']) {
    const value = image?.[key];
    if (!Number.isInteger(value) || value <= 0 || value > MAP_MAX_DIMENSION) errors.push('מידות התמונה אינן תקינות.');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export function buildMapRecord(image, user) {
  return {
    data: String(image.data),
    mimeType: String(image.mimeType),
    width: Number(image.width),
    height: Number(image.height),
    updatedBy: String(user?.uid || ''),
    updatedByName: String(user?.name || '').slice(0, 200),
    schemaVersion: MAP_SCHEMA_VERSION
  };
}

// כתובת להצגה ב-<img>. רק סוגים מוכרים ו-base64 תקין — שום דבר מהמסמך לא
// נכנס ל-src בלי בדיקה.
export function mapImageSource(record) {
  const mimeType = String(record?.mimeType || '');
  const data = String(record?.data || '');
  if (!MAP_MIME_TYPES.includes(mimeType) || !data || !BASE64_PATTERN.test(data)) return '';
  return `data:${mimeType};base64,${data}`;
}

// סדר הניסיונות לדחיסה: מהאיכות הגבוהה לנמוכה, ואז מידות קטנות יותר.
export const MAP_COMPRESSION_STEPS = Object.freeze([
  [2400, 0.82], [2400, 0.7], [2000, 0.7], [2000, 0.6], [1600, 0.6], [1600, 0.5], [1280, 0.5], [1024, 0.45]
]);

export function scaledSize(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
