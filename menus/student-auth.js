/* ============================================================================
   student-auth.js — real Firebase Authentication for students, without
   breaking anyone currently using the app.

   ⚠️ READ THIS BEFORE DEPLOYING TO PRODUCTION ⚠️
   This touches sign-up, which is the one flow that can lock real students
   out if something's wrong. Test thoroughly with a couple of test accounts
   (a fresh signup AND an existing student logging in) before rolling this
   out broadly. I built this defensively (see design notes below) but I
   cannot run or test it against your actual Firebase project / obfuscated
   app at runtime, so verify it end-to-end yourself first.

   ============================================================================
   DESIGN — why nobody's existing access gets touched
   ============================================================================
   - NEW signups: the "Create account" form now asks for Name + Batch only
     (no password). On submit, this signs them in anonymously with real
     Firebase Auth (auth().currentUser.uid is a genuine Firebase-issued
     UID) and creates `secretkeys/{uid}` — their UID *is* their student ID
     from day one. A secret key is still auto-generated and stored on their
     doc (field `secretKey`) purely for your own reference/matching in the
     admin panel — it is never shown to the student and is not used as
     their doc ID.

   - EXISTING students (secret key login, password login, or the earlier
     device-ID-based guest flow from buy-modal.js): their existing
     `secretkeys/{id}` doc and ID are NEVER touched, renamed, or migrated.
     In the background, this script also signs them into Firebase Auth
     anonymously (if not already), and writes a small mapping doc —
     `studentAuthLinks/{firebaseUid}` → `{ legacyStudentId }` — so that from
     this point on, "who is the current student" resolves through that
     mapping back to their ORIGINAL id. Every existing userLocks entry
     everywhere in Firestore still keys off that original id, so nothing
     needs to be rewritten.

   - EMAIL UPGRADE (soft prompt, dismissible, shown once per session): any
     student without an email on their Firebase Auth account sees a small
     banner suggesting they add one. This calls `linkWithCredential` on
     their EXISTING anonymous auth session — the UID does not change, so
     the studentAuthLinks mapping (or their own account, for new signups)
     keeps working exactly as before. This just lets them recover access
     if they clear browser data or switch devices, by logging in with that
     email from anywhere.

   ============================================================================
   INTEGRATION
   ============================================================================
     <script type="module" src="menus/student-auth.js"></script>
   Load this BEFORE buy-modal.js / quiz-live.js (order matters: it sets
   `window.currentStudent`, which those scripts already check first).
   ============================================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  linkWithCredential, EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBXFcbQlTB1mXBsHd_bxnHdgS7dmHK_x3k',
  authDomain: 'exam-d9415.firebaseapp.com',
  projectId: 'exam-d9415',
  storageBucket: 'exam-d9415.firebasestorage.app',
  messagingSenderId: '258742955197',
  appId: '1:258742955197:web:a8e6a179f9e7c23c5b5bd4',
};
const fbApp = initializeApp(firebaseConfig, 'studentAuth');
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// ------------------------------------------------------------------------
// Legacy identity lookup — same resolution order used by buy-modal.js /
// quiz-live.js, kept in sync deliberately. This is what an EXISTING
// student's "current" ID looks like before this script ever ran.
// ------------------------------------------------------------------------
function getLegacyStudentId() {
  try {
    if (window.__studentId) return window.__studentId;
    const explicit = localStorage.getItem('studentId') || localStorage.getItem('alifmed_student_id') ||
      localStorage.getItem('secretKey') || localStorage.getItem('alifmed_secret_key');
    if (explicit) return explicit;
    return localStorage.getItem('atlas_device_id_v1') || null;
  } catch (e) {
    return null;
  }
}

function randomSecretKey() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function setCurrentStudentGlobal(id, name) {
  window.currentStudent = { id, name: name || window.currentStudent?.name || null };
  try {
    if (id) localStorage.setItem('studentId', id);
    if (name) localStorage.setItem('studentName', name);
  } catch (e) { /* storage unavailable */ }
}

// ------------------------------------------------------------------------
// Resolve the EFFECTIVE student id once Firebase Auth is ready: if a
// mapping to a legacy id exists for this UID, use that (preserves an
// existing student's access); otherwise the UID itself is the id (brand
// new signup, or a legacy id that happened to equal a fresh UID — either
// way self-consistent).
// ------------------------------------------------------------------------
async function resolveEffectiveStudent(uid) {
  try {
    const linkSnap = await getDoc(doc(db, 'studentAuthLinks', uid));
    if (linkSnap.exists() && linkSnap.data().legacyStudentId) {
      const legacyId = linkSnap.data().legacyStudentId;
      const studentSnap = await getDoc(doc(db, 'secretkeys', legacyId));
      return { id: legacyId, name: studentSnap.exists() ? studentSnap.data().name : null };
    }
  } catch (e) { /* fall through */ }
  try {
    const studentSnap = await getDoc(doc(db, 'secretkeys', uid));
    if (studentSnap.exists()) return { id: uid, name: studentSnap.data().name };
  } catch (e) { /* fall through */ }
  return { id: uid, name: null };
}

async function ensureAuthLinkForLegacyStudent(uid, legacyId) {
  try {
    const ref = doc(db, 'studentAuthLinks', uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { legacyStudentId: legacyId, linkedAt: serverTimestamp() });
    }
  } catch (e) { /* best-effort — student still works via legacy id this session */ }
}

// ------------------------------------------------------------------------
// Boot: sign in anonymously if needed, then resolve identity.
// ------------------------------------------------------------------------
let authReadyResolve;
const authReady = new Promise((res) => { authReadyResolve = res; });

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); } catch (e) { console.error('[student-auth] anonymous sign-in failed', e); authReadyResolve(); }
    return; // onAuthStateChanged will fire again once signed in
  }

  const legacyId = getLegacyStudentId();
  if (legacyId && legacyId !== user.uid) {
    // Existing student on this device — preserve their original id.
    await ensureAuthLinkForLegacyStudent(user.uid, legacyId);
  }

  const effective = await resolveEffectiveStudent(user.uid);
  setCurrentStudentGlobal(effective.id, effective.name);
  authReadyResolve();
  maybeShowEmailPrompt(user);
});

// ------------------------------------------------------------------------
// Signup form takeover — Name + Batch, no password, key generated silently.
// ------------------------------------------------------------------------
function wireSignupForm() {
  const nameInput = document.getElementById('signupNameInput');
  const passwordInput = document.getElementById('signupPasswordInput');
  const confirmInput = document.getElementById('signupPasswordConfirm');
  const submitBtn = document.getElementById('signupSubmit');
  const signupBlock = document.getElementById('signupBlock');
  if (!nameInput || !submitBtn || !signupBlock) return; // gate screen not in DOM yet
  if (signupBlock.dataset.saTakenOver) return; // already wired
  signupBlock.dataset.saTakenOver = '1';

  // Hide the password fields — no longer needed for signup. IMPORTANT: we
  // hide rather than remove() them. gate-screen.js (loaded later, inside
  // main.js) does its own getElementById('signupPasswordInput') /
  // getElementById('signupPasswordConfirm') at module-init time and then
  // unconditionally calls .addEventListener on whatever it gets back. If
  // we've already removed these nodes from the DOM by the time that runs,
  // it gets null and throws (Cannot read properties of null, reading
  // 'addEventListener'). Keeping the (now-empty, invisible) elements in
  // place keeps gate-screen.js's own wiring happy; our click-capture
  // handler on signupSubmit still fully owns the signup flow regardless.
  if (passwordInput) {
    const pwLabel = passwordInput.previousElementSibling;
    if (pwLabel && pwLabel.tagName === 'LABEL') pwLabel.style.display = 'none';
    passwordInput.style.display = 'none';
    passwordInput.removeAttribute('required');
  }
  if (confirmInput) {
    const confirmLabel = confirmInput.previousElementSibling;
    if (confirmLabel && confirmLabel.tagName === 'LABEL') confirmLabel.style.display = 'none';
    confirmInput.style.display = 'none';
    confirmInput.removeAttribute('required');
  }

  // Add a Batch field, matching the admin's own "add student" fields.
  if (!document.getElementById('signupBatchInput')) {
    const label = document.createElement('label');
    label.className = 'field-label';
    label.setAttribute('for', 'signupBatchInput');
    label.textContent = 'Batch';
    const input = document.createElement('input');
    input.className = 'text-input';
    input.id = 'signupBatchInput';
    input.type = 'text';
    input.placeholder = 'e.g. 2027 A';
    input.autocomplete = 'off';
    nameInput.insertAdjacentElement('afterend', input);
    nameInput.insertAdjacentElement('afterend', label);
  }

  // Replace whatever the original (obfuscated) click handler does — ours
  // runs in the capture phase so it fires first and stops the original.
  submitBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const name = nameInput.value.trim();
    const batch = document.getElementById('signupBatchInput')?.value.trim() || '';
    const errorEl = document.getElementById('gateError');
    if (errorEl) errorEl.textContent = '';

    if (!name) {
      if (errorEl) errorEl.textContent = 'Please enter your name.';
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = 'Creating account…';

    try {
      await authReady; // make sure we have a Firebase Auth user first
      let user = auth.currentUser;
      if (!user) {
        const cred = await signInAnonymously(auth);
        user = cred.user;
      }

      await setDoc(doc(db, 'secretkeys', user.uid), {
        name,
        batch,
        secretKey: randomSecretKey(), // internal reference only — never shown
        userLocks: {},
        createdAt: serverTimestamp(),
        authMethod: 'anonymous',
      }, { merge: true });

      setCurrentStudentGlobal(user.uid, name);

      // Hand off to the app's normal screen transition.
      document.getElementById('gateScreen')?.classList.add('hidden');
      document.getElementById('homeScreen')?.classList.remove('hidden');
    } catch (err) {
      console.error('[student-auth] signup failed', err);
      if (errorEl) errorEl.textContent = 'Something went wrong creating your account. Please try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  }, true);
}

new MutationObserver(wireSignupForm).observe(document.body, { childList: true, subtree: true });
wireSignupForm();

// ------------------------------------------------------------------------
// Soft email-upgrade prompt — shown once per session, dismissible, only
// for accounts that don't have an email credential linked yet.
// ------------------------------------------------------------------------
let emailPromptShown = false;

const promptStyle = document.createElement('style');
promptStyle.textContent = `
  .sa-email-banner {
    position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 9998;
    background: var(--card, #fff); border: 1.5px solid var(--card-border, #eee);
    border-radius: 16px; padding: 14px 16px; box-shadow: 0 10px 30px -12px rgba(0,0,0,.25);
    display: flex; align-items: center; gap: 12px; font-family: inherit;
  }
  .sa-email-banner .sa-icon { font-size: 18px; color: var(--accent, #2f7a5f); flex: none; }
  .sa-email-banner .sa-text { flex: 1; font-size: 12.5px; line-height: 1.35; }
  .sa-email-banner .sa-text b { display: block; font-size: 13.5px; margin-bottom: 2px; }
  .sa-email-banner button { flex: none; }
  .sa-email-btn { border: none; background: var(--accent, #2f7a5f); color: #fff; font-size: 12px; font-weight: 700; padding: 8px 12px; border-radius: 10px; cursor: pointer; }
  .sa-email-dismiss { border: none; background: none; color: var(--ink-faint, #999); font-size: 14px; cursor: pointer; padding: 4px; }

  .sa-email-modal-overlay {
    position: fixed; inset: 0; z-index: 9999; background: rgba(10,14,12,.55);
    display: flex; align-items: center; justify-content: center;
    opacity: 0; visibility: hidden; transition: opacity .2s ease, visibility .2s ease;
  }
  .sa-email-modal-overlay.show { opacity: 1; visibility: visible; }
  .sa-email-modal { width: min(360px, 92vw); background: var(--card, #fff); border-radius: 18px; padding: 20px; font-family: inherit; }
  .sa-email-modal h3 { font-family: 'Fraunces', Georgia, serif; font-size: 17px; margin-bottom: 12px; }
  .sa-email-modal input { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1.5px solid var(--card-border, #ddd); font-size: 14px; margin-bottom: 10px; font-family: inherit; }
  .sa-email-modal .sa-error { color: #d34848; font-size: 12px; margin-bottom: 8px; display: none; }
  .sa-email-modal .sa-error.show { display: block; }
  .sa-email-modal-actions { display: flex; gap: 8px; margin-top: 6px; }
  .sa-email-modal-actions button { flex: 1; padding: 11px; border-radius: 10px; font-size: 13px; font-weight: 700; cursor: pointer; }
  .sa-email-cancel { border: 1.5px solid var(--card-border, #ddd); background: none; }
  .sa-email-save { border: none; background: var(--accent, #2f7a5f); color: #fff; }
`;
document.head.appendChild(promptStyle);

function maybeShowEmailPrompt(user) {
  if (emailPromptShown) return;
  if (!user || user.email) return; // already has email — nothing to prompt
  if (sessionStorage.getItem('sa_email_prompt_dismissed')) return;
  if (document.getElementById('gateScreen') && !document.getElementById('gateScreen').classList.contains('hidden')) return; // don't show over the login screen itself
  emailPromptShown = true;

  const banner = document.createElement('div');
  banner.className = 'sa-email-banner';
  banner.innerHTML = `
    <i class="fa-solid fa-shield-halved sa-icon"></i>
    <div class="sa-text"><b>Save your account</b>Add an email so you don't lose access if you switch devices.</div>
    <button class="sa-email-btn" id="saEmailAddBtn">Add email</button>
    <button class="sa-email-dismiss" id="saEmailDismissBtn"><i class="fa-solid fa-xmark"></i></button>
  `;
  document.body.appendChild(banner);

  document.getElementById('saEmailDismissBtn').addEventListener('click', () => {
    banner.remove();
    sessionStorage.setItem('sa_email_prompt_dismissed', '1');
  });
  document.getElementById('saEmailAddBtn').addEventListener('click', () => {
    banner.remove();
    openEmailModal();
  });
}

function openEmailModal() {
  const overlay = document.createElement('div');
  overlay.className = 'sa-email-modal-overlay';
  overlay.innerHTML = `
    <div class="sa-email-modal">
      <h3>Add your email</h3>
      <input type="email" id="saEmailInput" placeholder="you@example.com" autocomplete="email" />
      <input type="password" id="saPasswordInput" placeholder="Choose a password" autocomplete="new-password" />
      <div class="sa-error" id="saEmailError"></div>
      <div class="sa-email-modal-actions">
        <button class="sa-email-cancel" id="saEmailCancelBtn">Cancel</button>
        <button class="sa-email-save" id="saEmailSaveBtn">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  const close = () => { overlay.classList.remove('show'); setTimeout(() => overlay.remove(), 200); };
  document.getElementById('saEmailCancelBtn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.getElementById('saEmailSaveBtn').addEventListener('click', async () => {
    const email = document.getElementById('saEmailInput').value.trim();
    const password = document.getElementById('saPasswordInput').value;
    const errorEl = document.getElementById('saEmailError');
    errorEl.classList.remove('show');

    if (!email || !password || password.length < 6) {
      errorEl.textContent = 'Enter a valid email and a password of at least 6 characters.';
      errorEl.classList.add('show');
      return;
    }
    try {
      const credential = EmailAuthProvider.credential(email, password);
      await linkWithCredential(auth.currentUser, credential); // same UID — nothing else changes
      close();
    } catch (err) {
      errorEl.textContent = err.code === 'auth/email-already-in-use'
        ? 'That email is already linked to another account.'
        : 'Could not save — please try again.';
      errorEl.classList.add('show');
    }
  });
}
