import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  EVENT_STAFFING_SCHEMA_VERSION, ROLES, profileForActiveEvent
} from './roles.js';

export async function resolveActiveUserContext(db, uid, profile = {}) {
  if (!db || !uid) throw new Error('לא ניתן לזהות את המשתמש המחובר.');
  if (profile.role === ROLES.ADMIN) return profileForActiveEvent(profile);

  const pointerSnapshot = await getDoc(doc(db, 'settings', 'activeEvent'));
  const pointer = pointerSnapshot.exists() ? pointerSnapshot.data() : {};
  if (pointer.status !== 'active' || !pointer.eventId ||
      Number(pointer.eventStaffingSchemaVersion || 0) !== EVENT_STAFFING_SCHEMA_VERSION) {
    return profileForActiveEvent(profile, pointer);
  }

  const staffSnapshot = await getDoc(doc(db, 'events', String(pointer.eventId), 'staff', String(uid)));
  return profileForActiveEvent(profile, pointer, staffSnapshot.exists() ? staffSnapshot.data() : null);
}
