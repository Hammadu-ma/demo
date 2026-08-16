/* =========================================================================
   Gate screen
   ========================================================================= */
import { getStoredStudent, markKeyAsUsed, storeStudent, validateSecretKey } from './auth.js';
import { startUnreadTracking, upsertChatProfile } from './class-chat.js';
import { enforceDeviceLock, startHeartbeat } from './device-session.js';
import { db } from './firebase-config.js';
import { continueWithDashboardAccount, createGuestStudent, getDashboardUser, studentFromDashboardUser } from './guest-dashboard.js';
import { firstName, showHome, showPicker } from './home-screen.js';
import { popModalState, pushModalState } from './modal-backbutton.js';
import { initials } from './picker-screen.js';
import { showToast } from './ui-feedback.js';
import { addDoc, collection, getDocs, query, serverTimestamp, where } from './vendor.js';

    /* =========================================================================
       6. Gate screen
       ========================================================================= */
    export const gateScreen = document.getElementById('gateScreen');
    export const pickerScreen = document.getElementById('pickerScreen');
    export const homeScreen = document.getElementById('homeScreen');
    export const appScreen = document.getElementById('appScreen');
    export const gateError = document.getElementById('gateError');
    const secretInput = document.getElementById('secretInput');
    const secretSubmit = document.getElementById('secretSubmit');
    const expiryWarning = document.getElementById('expiryWarning');

    async function attemptLogin(key) {
      gateError.classList.remove('show');
      if (!key) { return; }
      secretSubmit.classList.add('loading');
      secretSubmit.disabled = true;
      try {
        const student = await validateSecretKey(key.trim());
        if (!student) {
          gateError.textContent = "That key wasn't recognized. Check with the admin on @Alif Medm.";
          gateError.classList.add('show');
        } else {
          // Device-specific session enforcement (global or per-student toggle)
          const lockCheck = await enforceDeviceLock(student);
          if (!lockCheck.ok) {
            gateError.textContent = lockCheck.reason;
            gateError.classList.add('show');
            secretSubmit.classList.remove('loading');
            secretSubmit.disabled = false;
            return;
          }

          // Mark one-time use key as used
          await markKeyAsUsed(student);
          
          // Store the student with the Firestore document ID + this device's id
          storeStudent({ 
            ...student, 
            secretkey: key.trim(),
            id: student.id || student.docId,
            deviceId: lockCheck.device.deviceId
          });
          upsertChatProfile(getStoredStudent());
          showPicker();
          startHeartbeat();
          startUnreadTracking();
        }
      } catch (e) {
        if (e.message === 'EXPIRED') {
          gateError.textContent = "This login key has expired. Please contact your instructor for a new key.";
          gateError.classList.add('show');
          expiryWarning.innerHTML = `
            <div class="expiry-warning">
              <i class="fa-solid fa-clock"></i>
              <span>The login key has expired. Please contact your instructor for a new key.</span>
            </div>
          `;
        } else if (e.message === 'USED') {
          gateError.textContent = "This key has already been used and is one-time use only. Please contact your instructor for a new key.";
          gateError.classList.add('show');
        } else {
          gateError.textContent = "Couldn't reach the server and no offline record exists for this key. Connect once to your network to verify it the first time.";
          gateError.classList.add('show');
        }
      } finally {
        secretSubmit.classList.remove('loading');
        secretSubmit.disabled = false;
      }
    }
    secretSubmit.addEventListener('click', () => attemptLogin(secretInput.value));
    secretInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(secretInput.value); });

    /* -----------------------------------------------------------------------
       Sign Up (name + batch) — the self-service alternative to an admin-issued
       secret key. Mirrors exactly what the admin panel does when it adds a
       student by hand: it writes a document into the same 'secretkeys'
       collection with an auto-generated ID and a 4-digit secret key, so
       resource management (userLocks, admin visibility) works identically to
       any other student. The secret key IS the account from this point on —
       there is no separate password, and no other way to log back in — so
       the key is shown once, right after signup, and the student must
       acknowledge it before continuing.
       ----------------------------------------------------------------------- */
    const signupBlock = document.getElementById('signupBlock');
    const signupNameInput = document.getElementById('signupNameInput');
    const signupBatchInput = document.getElementById('signupBatchInput');
    const signupSubmit = document.getElementById('signupSubmit');
    const goToSignupLink = document.getElementById('goToSignupLink');
    const backToKeyLink = document.getElementById('backToKeyLink');
    const guestContinueLink = document.getElementById('guestContinueLink');
    const signupKeyReveal = document.getElementById('signupKeyReveal');
    const signupKeyRevealName = document.getElementById('signupKeyRevealName');
    const generatedKeyDisplay = document.getElementById('generatedKeyDisplay');
    const copyGeneratedKeyBtn = document.getElementById('copyGeneratedKeyBtn');
    const signupContinueBtn = document.getElementById('signupContinueBtn');

    let CURRENT_AUTH_VIEW = 'key';
    function setAuthView(view) {
      CURRENT_AUTH_VIEW = view;
      keyEntryBlock.classList.toggle('hidden', view !== 'key');
      signupBlock.classList.toggle('hidden', view !== 'signup');
      if (view !== 'reveal') signupKeyReveal.classList.add('hidden');
      gateError.classList.remove('show');
    }
    goToSignupLink.addEventListener('click', () => setAuthView('signup'));
    backToKeyLink.addEventListener('click', () => setAuthView('key'));

    // Matches the admin panel's own 4-digit key format exactly, with a
    // uniqueness check against Firestore so two students never collide.
    async function generateUniqueSecretKey() {
      for (let i = 0; i < 20; i++) {
        const candidate = String(Math.floor(1000 + Math.random() * 9000));
        const snap = await getDocs(query(collection(db, 'secretkeys'), where('secretkey', '==', candidate)));
        if (snap.empty) return candidate;
      }
      // Extremely unlikely fallback if the 4-digit keyspace is saturated.
      for (let i = 0; i < 20; i++) {
        const candidate = String(Math.floor(100000 + Math.random() * 900000));
        const snap = await getDocs(query(collection(db, 'secretkeys'), where('secretkey', '==', candidate)));
        if (snap.empty) return candidate;
      }
      throw new Error('KEY_GEN_FAILED');
    }

    // Auto-generated student ID, since self-signup has no institution roster
    // to pull a real one from. Prefixed so it's clearly distinguishable from
    // an admin-assigned ID at a glance.
    async function generateUniqueStudentId() {
      for (let i = 0; i < 20; i++) {
        const candidate = 'AM' + String(Math.floor(100000 + Math.random() * 900000));
        const snap = await getDocs(query(collection(db, 'secretkeys'), where('ID', '==', candidate)));
        if (snap.empty) return candidate;
      }
      return 'AM' + Date.now().toString(36).toUpperCase();
    }

    async function attemptSignup(name, batch) {
      gateError.classList.remove('show');
      name = (name || '').trim();
      batch = (batch || '').trim();
      if (!name) { gateError.textContent = 'Please enter your name.'; gateError.classList.add('show'); return; }

      signupSubmit.classList.add('loading');
      signupSubmit.disabled = true;
      try {
        const [studentIdVal, secretKeyVal] = await Promise.all([generateUniqueStudentId(), generateUniqueSecretKey()]);
        const docRef = await addDoc(collection(db, 'secretkeys'), {
          name,
          batch,
          ID: studentIdVal,
          secretkey: secretKeyVal,
          userLocks: {},
          oneTimeUse: false,
          used: true,
          appearInChat: true,
          deviceLockEnabled: false,
          source: 'selfRegistered',
          createdAt: serverTimestamp()
        });
        const student = {
          id: docRef.id, docId: docRef.id, name, batch,
          ID: studentIdVal, secretkey: secretKeyVal,
          oneTimeUse: false, used: true, appearInChat: true,
          deviceLockEnabled: false, userLocks: {}
        };
        const lockCheck = await enforceDeviceLock(student).catch(() => ({ ok: true, device: {} }));
        storeStudent({ ...student, deviceId: lockCheck.device?.deviceId });
        upsertChatProfile(getStoredStudent()).catch(() => {});

        signupKeyRevealName.textContent = firstName(name);
        generatedKeyDisplay.textContent = secretKeyVal;
        copyGeneratedKeyBtn.classList.remove('copied');
        copyGeneratedKeyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy key';
        keyEntryBlock.classList.add('hidden');
        signupBlock.classList.add('hidden');
        signupKeyReveal.classList.remove('hidden');
        CURRENT_AUTH_VIEW = 'reveal';
      } catch (e) {
        console.error('Signup failed:', e);
        gateError.textContent = "Couldn't create your account — check your connection and try again.";
        gateError.classList.add('show');
      } finally {
        signupSubmit.classList.remove('loading');
        signupSubmit.disabled = false;
      }
    }
    signupSubmit.addEventListener('click', () => attemptSignup(signupNameInput.value, signupBatchInput.value));
    [signupNameInput, signupBatchInput].forEach(el => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptSignup(signupNameInput.value, signupBatchInput.value); });
    });

    copyGeneratedKeyBtn.addEventListener('click', async () => {
      const key = generatedKeyDisplay.textContent.trim();
      try {
        await navigator.clipboard.writeText(key);
      } catch (e) {
        // Clipboard API unavailable (e.g. non-secure context) — the key is
        // already big and selectable on screen, so this is a soft failure.
      }
      copyGeneratedKeyBtn.classList.add('copied');
      copyGeneratedKeyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
      setTimeout(() => {
        copyGeneratedKeyBtn.classList.remove('copied');
        copyGeneratedKeyBtn.innerHTML = '<i class="fa-regular fa-copy"></i> Copy key';
      }, 1800);
    });

    signupContinueBtn.addEventListener('click', () => {
      closeAuthGate();
      showToast(`Welcome, ${firstName(signupKeyRevealName.textContent)}!`, { icon: 'fa-solid fa-circle-check' });
      startHeartbeat();
      startUnreadTracking();
    });

    /* -----------------------------------------------------------------------
       Opening/closing the gate as a voluntary sign-up/log-in prompt (rather
       than a forced boot screen) — hides whichever screen was showing, and
       restores it on close. Hooks into the same modal-stack the rest of the
       app uses so the back button closes it like any other overlay.
       ----------------------------------------------------------------------- */
    let AUTH_GATE_RETURN = 'home';
    export function openAuthGate(defaultView = 'key') {
      AUTH_GATE_RETURN = (!pickerScreen.classList.contains('hidden')) ? 'picker' : 'home';
      homeScreen.classList.add('hidden');
      pickerScreen.classList.add('hidden');
      gateScreen.classList.remove('hidden');
      gateError.classList.remove('show');
      secretInput.value = '';
      setupGateForDashboardUser();
      const dash = getDashboardUser();
      if (dash) {
        signupBlock.classList.add('hidden');
        signupKeyReveal.classList.add('hidden');
      } else {
        setAuthView(defaultView === 'signup' ? 'signup' : 'key');
      }
      document.getElementById('gateCloseBtn')?.classList.remove('hidden');
      pushModalState(closeAuthGate);
    }
    function closeAuthGate() {
      gateScreen.classList.add('hidden');
      document.getElementById('gateCloseBtn')?.classList.add('hidden');
      popModalState(closeAuthGate);
      if (!getStoredStudent()) storeStudent(createGuestStudent());
      if (AUTH_GATE_RETURN === 'picker') showPicker({ skipHistory: true });
      else showHome({ skipHistory: true });
    }
    document.getElementById('gateCloseBtn')?.addEventListener('click', closeAuthGate);
    guestContinueLink.addEventListener('click', closeAuthGate);

    /* -----------------------------------------------------------------------
       Gate screen: show a "Continue as <name>" card whenever a Dashboard
       account is present on this device, so registered users hardly ever
       need to touch the secret-key field at all.
       ----------------------------------------------------------------------- */
    const dashContinueBlock = document.getElementById('dashContinueBlock');
    const keyEntryBlock = document.getElementById('keyEntryBlock');
    const dashUseKeyToggle = document.getElementById('dashUseKeyToggle');
    const dashContinueBtn = document.getElementById('dashContinueBtn');

    function setupGateForDashboardUser() {
      const dash = getDashboardUser();
      if (!dash) {
        dashContinueBlock.classList.add('hidden');
        keyEntryBlock.classList.remove('hidden');
        dashUseKeyToggle.classList.add('hidden');
        return;
      }
      const previewStudent = studentFromDashboardUser(dash);
      document.getElementById('dashContinueAvatar').textContent = initials(previewStudent.name);
      document.getElementById('dashContinueName').textContent = previewStudent.name;
      dashContinueBlock.classList.remove('hidden');
      keyEntryBlock.classList.add('hidden');
      dashUseKeyToggle.classList.remove('hidden');
      dashUseKeyToggle.textContent = 'Use a secret key instead';
    }

    dashContinueBtn.addEventListener('click', () => continueWithDashboardAccount());
    dashUseKeyToggle.addEventListener('click', () => {
      const showingKeyEntry = !keyEntryBlock.classList.contains('hidden');
      if (showingKeyEntry) {
        keyEntryBlock.classList.add('hidden');
        dashContinueBlock.classList.remove('hidden');
        dashUseKeyToggle.textContent = 'Use a secret key instead';
        signupBlock.classList.add('hidden');
        signupKeyReveal.classList.add('hidden');
      } else {
        dashContinueBlock.classList.add('hidden');
        setAuthView('key');
        dashUseKeyToggle.textContent = 'Continue with your account';
      }
    });

