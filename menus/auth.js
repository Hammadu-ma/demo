/* =========================================================================
   Student login with secret key
   ========================================================================= */
import { LSC, withTimeout } from './cache.js';
import { db } from './firebase-config.js';
import { PROGRESS_KEY_PREFIX, REMOTE_PROGRESS_KEY_PREFIX, invalidateRemoteProgressCache } from './progress-rings.js';
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from './vendor.js';

    /* =========================================================================
       3. Auth — Student Login with Secret Key
       ========================================================================= */
    const STUDENT_KEY = 'atlas_student_v1';

    // Any registered user already signed in on the Dashboard (localStorage key set by
    // dashboard.html after login/registration) is welcomed straight in here — no separate
    // secret key required. This key name must match the dashboard's own storage key.
    export const DASH_USER_KEY = 'medicalUser';
    // Set for the current tab only when the person explicitly logs out of THIS app while
    // still signed into the Dashboard — so we don't immediately bounce them back in.
    export const DASH_DISMISS_KEY = 'atlas_dash_dismissed_v1';

    // Check if sync is enabled - uses per-student override OR global setting
    let SYSTEM_SETTINGS_CACHE = null;
    let SYSTEM_SETTINGS_CACHE_TS = 0;
    async function getSystemSettingsCached() {
      if (SYSTEM_SETTINGS_CACHE && (Date.now() - SYSTEM_SETTINGS_CACHE_TS) < 60000) return SYSTEM_SETTINGS_CACHE;
      if (!db) return SYSTEM_SETTINGS_CACHE || {};
      try {
        const snap = await withTimeout(getDoc(doc(db, 'settings', 'system')), 1200);
        SYSTEM_SETTINGS_CACHE = snap.exists() ? snap.data() : {};
        SYSTEM_SETTINGS_CACHE_TS = Date.now();
        return SYSTEM_SETTINGS_CACHE;
      } catch (e) {
        // Slow/offline — serve whatever we last knew rather than stalling the caller.
        return SYSTEM_SETTINGS_CACHE || {};
      }
    }

    export async function shouldSyncToFirebase() {
      try {
        const student = getStoredStudent();
        // PER-STUDENT OVERRIDE TAKES PRECEDENCE
        if (student && student.syncEnabled !== undefined && student.syncEnabled !== null) {
          return student.syncEnabled;
        }
        if (!db) return false;
        const settings = await getSystemSettingsCached();
        return settings.syncEnabled === true;
      } catch (e) {
        console.warn('Could not check sync setting:', e);
        return false;
      }
    }

    // Check if progress tracking (cross-device insights sync) is enabled - per-student override OR global setting.
    // When this is off, quiz progress used for the cards/insights page lives in localStorage only.
    async function shouldTrackProgress() {
      try {
        const student = getStoredStudent();
        if (student && student.progressTrackingEnabled !== undefined && student.progressTrackingEnabled !== null) {
          return student.progressTrackingEnabled;
        }
        if (!db) return false;
        const settings = await getSystemSettingsCached();
        return settings.progressTrackingEnabled === true;
      } catch (e) {
        return false;
      }
    }

    let PROGRESS_PUSH_TIMER = null;
    export function pushProgressSnapshot(subjectId, quizId) {
      clearTimeout(PROGRESS_PUSH_TIMER);
      PROGRESS_PUSH_TIMER = setTimeout(async () => {
        const tracking = await shouldTrackProgress();
        if (!tracking || !db) return;
        const student = getStoredStudent();
        if (!student || !(student.id || student.docId)) return;
        const saved = LSC.get(`${PROGRESS_KEY_PREFIX}${student.id}_${subjectId}_${quizId}`);
        if (!saved) return;
        const answeredCount = Object.keys(saved.answers || {}).length;
        const correctCount = Object.values(saved.answers || {}).filter(a => a.correct).length;
        try {
          await setDoc(doc(db, 'progress', student.id || student.docId), {
            subjects: {
              [subjectId]: {
                [quizId]: {
                  total: saved.total || 0,
                  answeredCount,
                  correctCount,
                  completed: !!saved.completed,
                  updatedAt: serverTimestamp()
                }
              }
            },
            updatedAt: serverTimestamp()
          }, { merge: true });
        } catch (e) { /* offline — retried on the next answer or app open */ }
      }, 900);
    }

    // Pulls the cross-device progress summary into a local mirror so cards/insights reflect
    // quizzes taken on other devices too. This mirror is display-only — it never overwrites the
    // real per-question answers used to resume a quiz, so nothing the student did here is lost.
    export async function mergeRemoteProgress() {
      const tracking = await shouldTrackProgress();
      if (!tracking || !db) return false;
      const student = getStoredStudent();
      if (!student || !(student.id || student.docId)) return false;
      try {
        const snap = await withTimeout(getDoc(doc(db, 'progress', student.id || student.docId)), 1400);
        if (!snap.exists()) return false;
        const data = snap.data();
        LSC.set(`${REMOTE_PROGRESS_KEY_PREFIX}${student.id}`, data.subjects || {});
        invalidateRemoteProgressCache();
        return true;
      } catch (e) { return false; }
    }

    // Check if a key is expired using its own expiresAt field
    function isKeyExpired(studentData) {
      if (!studentData?.expiresAt) return false;
      const expiry = studentData.expiresAt.toMillis?.() || studentData.expiresAt;
      if (!expiry) return false;
      return Date.now() > expiry;
    }

    // Validate a secret key against Firestore
    export async function validateSecretKey(key) {
      const cacheKey = 'atlas_secretkeys_cache';
      try {
        const snap = await getDocs(query(collection(db, 'secretkeys'), where('secretkey', '==', key)));
        if (!snap.empty) {
          const docData = snap.docs[0].data();
          const docId = snap.docs[0].id;
          
          // Check if the key is expired (per-key expiry)
          if (isKeyExpired(docData)) {
            throw new Error('EXPIRED');
          }
          
          // Check if it's a one-time use key that's already been used
          if (docData.oneTimeUse !== false && docData.used === true) {
            throw new Error('USED');
          }
          
          const studentData = { 
            ...docData, 
            id: docId,
            docId: docId,
            secretkey: key
          };
          
          const roster = LSC.get(cacheKey) || {};
          roster[key] = studentData;
          LSC.set(cacheKey, roster);
          return studentData;
        }
        return null;
      } catch (e) {
        if (e.message === 'EXPIRED' || e.message === 'USED') throw e;
        const roster = LSC.get(cacheKey) || {};
        if (roster[key]) {
          const cached = roster[key];
          if (isKeyExpired(cached)) throw new Error('EXPIRED');
          return cached;
        }
        throw e;
      }
    }

    // Mark a key as used after successful login (for one-time use keys)
    export async function markKeyAsUsed(student) {
      if (student.oneTimeUse !== false) {
        try {
          const ref = doc(db, 'secretkeys', student.id);
          await updateDoc(ref, {
            used: true,
            usedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
          student.used = true;
          student.usedAt = new Date().toISOString();
        } catch (e) {
          console.warn('Could not mark key as used:', e);
        }
      }
    }

    export function getStoredStudent() { 
      const student = LSC.get(STUDENT_KEY);
      if (student && !student.id && student.docId) {
        student.id = student.docId;
        LSC.set(STUDENT_KEY, student);
      }
      return student;
    }

    export function storeStudent(s) { 
      if (!s.id && s.docId) s.id = s.docId;
      LSC.set(STUDENT_KEY, s); 
    }

    export function clearStudent() { localStorage.removeItem(STUDENT_KEY); }

