/* =========================================================================
   Guest access + dashboard bridge
   ========================================================================= */
import { DASH_DISMISS_KEY, DASH_USER_KEY, storeStudent } from './auth.js';
import { startUnreadTracking, upsertChatProfile } from './class-chat.js';
import { IS_DEVICE_BLOCKED, enforceDeviceLock, setIS_DEVICE_BLOCKED, showBlockedGate, startHeartbeat } from './device-session.js';
import { gateError, gateScreen } from './gate-screen.js';
import { showPicker } from './home-screen.js';

    /* =========================================================================
       3a. Guest access — the app opens straight to the home screen for anyone,
       no login required. A lightweight, non-persisted "guest" student object is
       used locally so every existing screen (which reads getStoredStudent())
       keeps working unmodified; resources behave exactly as they would for a
       freshly self-registered account with no unlocks (default lock state).
       Nothing about a guest is written to Firestore — the moment they sign up
       or log in, this local object is replaced by a real student record.
       ========================================================================= */
    export function createGuestStudent() {
      const id = 'guest_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      return {
        id, docId: id,
        name: 'Guest',
        ID: '', batch: '',
        secretkey: '',
        guest: true,
        source: 'guest',
        oneTimeUse: false,
        used: true,
        appearInChat: false,
        deviceLockEnabled: false,
        userLocks: {}
      };
    }

    /* =========================================================================
       3b. Dashboard bridge — anyone already registered and signed into the
       Dashboard (i.e. has a "medicalUser" profile stored on this device) gets
       welcomed straight into Alif Med using that same profile, no secret key
       needed. This is intentionally generous: it never blocks on a missing
       field, and any Firestore write it attempts is best-effort (wrapped in
       try/catch elsewhere) so it degrades gracefully if a matching secretkeys
       document doesn't exist for this person.
       ========================================================================= */
    export function getDashboardUser() {
      try {
        const raw = localStorage.getItem(DASH_USER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || (!parsed.uid && !parsed.email && !parsed.fullName)) return null;
        return parsed;
      } catch (e) { return null; }
    }

    // Turn the dashboard's user object into the shape this app expects for a student.
    export function studentFromDashboardUser(dash) {
      const uidPart = dash.uid || (dash.email ? dash.email.split('@')[0] : '') || 'guest';
      const id = 'dash_' + String(uidPart).replace(/[^a-zA-Z0-9_-]/g, '');
      const programs = Array.isArray(dash.programs) && dash.programs.length
        ? dash.programs
        : (dash.program ? [dash.program] : []);
      return {
        id,
        docId: id,
        name: dash.fullName || (dash.email ? dash.email.split('@')[0] : 'Student'),
        ID: dash.email || '',
        batch: programs.join(', '),
        email: dash.email || '',
        secretkey: '',
        oneTimeUse: false,
        used: true,
        appearInChat: true,
        deviceLockEnabled: false, // dashboard accounts aren't device-limited
        source: 'dashboard',
        dashboardUid: dash.uid || null
      };
    }

    // Silently log a dashboard-registered person straight in (called from boot()).
    // Returns the student object on success, or null if there's nothing to use.
    export function tryAutoLoginFromDashboard() {
      try {
        if (sessionStorage.getItem(DASH_DISMISS_KEY) === '1') return null;
      } catch (e) { /* ignore */ }
      const dash = getDashboardUser();
      if (!dash) return null;
      const student = studentFromDashboardUser(dash);
      storeStudent(student);
      upsertChatProfile(student).catch(() => {});
      // Register this device against the student's admin record in the background, so the
      // instructor console can see and manage dashboard-linked sessions the same way it does
      // secret-key ones. If admin has forced device-lock on for this student and this device
      // isn't allowed, catch it on the next screen rather than blocking boot() on it.
      enforceDeviceLock(student).then(res => {
        if (res && res.ok === false) {
          setIS_DEVICE_BLOCKED(true);
          showBlockedGate(res.reason);
        }
      }).catch(() => {});
      return student;
    }

    // Explicit "Continue" tap from the gate screen (used when the person logged out of
    // Alif Med earlier in this tab but is still signed into the Dashboard).
    export async function continueWithDashboardAccount() {
      const dash = getDashboardUser();
      if (!dash) return;
      try { sessionStorage.removeItem(DASH_DISMISS_KEY); } catch (e) {}
      const student = studentFromDashboardUser(dash);
      storeStudent(student);
      await upsertChatProfile(student).catch(() => {});
      const lockCheck = await enforceDeviceLock(student).catch(() => ({ ok: true }));
      if (lockCheck && lockCheck.ok === false) {
        gateError.textContent = lockCheck.reason;
        gateError.classList.add('show');
        return;
      }
      gateScreen.classList.add('hidden');
      showPicker();
      startHeartbeat();
      startUnreadTracking();
    }

