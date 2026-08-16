/* ============================================================================
   quiz-live.js — LIVE badges + pin toggle for quiz cards, and a "Live now"
   section above continue practicing with horizontally scrollable live quizzes.

   Reads (per quiz, matched by name — see LIMITATION below):
     - liveStart / liveEnd (ISO strings) — set in the admin's "Live Quizzes"
       panel. When "now" falls inside this window, the quiz is LIVE.
     - pinnedByAdmin (bool) — also set in that same admin panel; pins the
       quiz for every student.
   Writes (personal, per student):
     - studentPins/{studentId}.quizIds — array of quiz IDs this student has
       personally pinned. Toggled by tapping the pin icon on any quiz card.

   LIMITATION — name-based matching
   Same constraint as buy-modal.js: the rest of the app is obfuscated, so
   quizzes are matched by their rendered name, not a Firestore doc ID. Two
   quizzes sharing an identical name are treated as the same quiz here.

   INTEGRATION
   Add this next to buy-modal.js in index.html:
     <script type="module" src="menus/quiz-live.js"></script>
   ============================================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getFirestore, collectionGroup, getDocs,
  doc, getDoc, setDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBXFcbQlTB1mXBsHd_bxnHdgS7dmHK_x3k',
  authDomain: 'exam-d9415.firebaseapp.com',
  projectId: 'exam-d9415',
  storageBucket: 'exam-d9415.firebasestorage.app',
  messagingSenderId: '258742955197',
  appId: '1:258742955197:web:a8e6a179f9e7c23c5b5bd4',
};
const fbApp = initializeApp(firebaseConfig, 'quizLive');
const db = getFirestore(fbApp);

// ------------------------------------------------------------------------
// Student identity — same resolution order as buy-modal.js (explicit
// login, else the app's own persistent device ID for guests).
// ------------------------------------------------------------------------
function getCurrentStudentId() {
  try {
    if (window.currentStudent && window.currentStudent.id) return window.currentStudent.id;
    if (window.__studentId) return window.__studentId;
    const explicit = localStorage.getItem('studentId') || localStorage.getItem('alifmed_student_id') ||
      localStorage.getItem('secretKey') || localStorage.getItem('alifmed_secret_key');
    if (explicit) return explicit;
    return localStorage.getItem('atlas_device_id_v1') || null;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------------
// Personal pins — cached in memory after first load, updated optimistically
// on toggle.
// ------------------------------------------------------------------------
let PERSONAL_PINS = new Set();
let PERSONAL_PINS_LOADED = false;

async function loadPersonalPins() {
  const studentId = getCurrentStudentId();
  if (!studentId || PERSONAL_PINS_LOADED) return;
  PERSONAL_PINS_LOADED = true;
  try {
    const snap = await getDoc(doc(db, 'studentPins', studentId));
    if (snap.exists()) PERSONAL_PINS = new Set(snap.data().quizIds || []);
  } catch (e) { /* best-effort */ }
}

async function togglePersonalPin(quizId) {
  const studentId = getCurrentStudentId();
  if (!studentId) return;
  const wasPinned = PERSONAL_PINS.has(quizId);
  if (wasPinned) PERSONAL_PINS.delete(quizId); else PERSONAL_PINS.add(quizId);
  try {
    await setDoc(doc(db, 'studentPins', studentId), { quizIds: [...PERSONAL_PINS] });
  } catch (e) {
    // revert on failure
    if (wasPinned) PERSONAL_PINS.add(quizId); else PERSONAL_PINS.delete(quizId);
  }
}

// ------------------------------------------------------------------------
// Quiz data lookup — fetches the whole quizzes collection group ONCE and
// filters by name in memory (instead of a `where()` query on the
// collection group, which needs a Firestore composite index that may not
// exist and would fail silently). Mirrors the admin panel's approach.
// ------------------------------------------------------------------------
let ALL_QUIZZES_PROMISE = null;
async function getAllQuizzes() {
  if (!ALL_QUIZZES_PROMISE) {
    ALL_QUIZZES_PROMISE = (async () => {
      try {
        const snap = await getDocs(collectionGroup(db, 'quizzes'));
        return snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
      } catch (e) {
        console.error('[quiz-live] could not load quizzes', e);
        return [];
      }
    })();
  }
  return ALL_QUIZZES_PROMISE;
}

async function getQuizByName(name) {
  const all = await getAllQuizzes();
  return all.find((q) => (q.name || '').trim() === name.trim()) || null;
}

function liveStatus(q) {
  if (!q || !q.liveStart || !q.liveEnd) return 'none';
  const now = Date.now();
  const start = new Date(q.liveStart).getTime();
  const end = new Date(q.liveEnd).getTime();
  if (now >= start && now <= end) return 'live';
  return 'none';
}

function formatCountdown(endIso) {
  const ms = new Date(endIso).getTime() - Date.now();
  if (ms <= 0) return 'ending now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m left`;
  return `${Math.floor(hrs / 24)}d left`;
}

// ------------------------------------------------------------------------
// Styles for live badges on quiz cards
// ------------------------------------------------------------------------
const style = document.createElement('style');
style.textContent = `
  @keyframes ql-pulse { 
    0% { box-shadow: 0 0 0 0 rgba(255,0,0,.8), 0 0 15px 0 rgba(255,0,0,.6); } 
    40% { box-shadow: 0 0 0 12px rgba(255,0,0,.3), 0 0 25px 0 rgba(255,0,0,.4); } 
    70% { box-shadow: 0 0 0 24px rgba(255,0,0,0), 0 0 35px 0 rgba(255,0,0,.1); } 
    100% { box-shadow: 0 0 0 0 rgba(255,0,0,0), 0 0 15px 0 rgba(255,0,0,.6); } 
  }
  @keyframes ql-dot-pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.3); }
  }
  .ql-live-badge {
    position: absolute; top: 10px; left: 10px; z-index: 5;
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px 6px 8px; border-radius: 999px;
    background: #ff0000; color: #fff; font-size: 11px; font-weight: 900;
    letter-spacing: .05em; text-transform: uppercase;
    box-shadow: 0 0 20px rgba(255,0,0,.8), 0 4px 12px -2px rgba(255,0,0,.7);
    animation: ql-badge-glow 1.2s ease-in-out infinite;
  }
  @keyframes ql-badge-glow {
    0%, 100% { filter: brightness(1) drop-shadow(0 0 8px rgba(255,0,0,.8)); }
    50% { filter: brightness(1.15) drop-shadow(0 0 16px rgba(255,0,0,1)); }
  }
  .ql-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: ql-dot-pulse 0.8s ease-in-out infinite; box-shadow: 0 0 6px #fff; }
  .ql-live-countdown {
    position: absolute; bottom: 8px; left: 10px; z-index: 5;
    font-size: 10px; font-weight: 700; color: #d34848;
    background: rgba(255,255,255,.92); padding: 2px 7px; border-radius: 999px;
  }

  .ql-pin-btn {
    position: absolute; top: 10px; right: 10px; z-index: 5;
    width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer;
    background: rgba(0,0,0,.35); backdrop-filter: blur(4px);
    color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px;
    transition: transform .15s ease, background .15s ease;
  }
  .ql-pin-btn:hover { transform: scale(1.08); }
  .ql-pin-btn.pinned { background: var(--accent, #2f7a5f); color: #fff; }

  /* Live card labels */
  .lc-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .05em;
    background: rgba(255,0,0,.1);
    color: #ff0000;
    margin-top: 8px;
  }
`;
document.head.appendChild(style);

// Track live quizzes for the live section
const LIVE_QUIZZES = new Map(); // quizId -> {id, name, liveEnd, subject, ...}

function renderLiveSection() {
  const liveQuizzes = [...LIVE_QUIZZES.values()].filter((q) => liveStatus(q) === 'live');
  const liveSection = document.getElementById('liveSection');
  
  if (!liveQuizzes.length) {
    liveSection?.classList.remove('has-items');
    return;
  }
  
  liveSection?.classList.add('has-items');
  const liveRail = document.getElementById('liveRail');
  if (!liveRail) return;
  
  liveRail.innerHTML = liveQuizzes.map((q) => {
    return `
    <div class="live-card" data-quiz-id="${q.id}">
      <span class="lc-badge">Live</span>
      <div class="cc-top">
        <div class="cc-icon"><i class="fa-solid fa-fire" style="color:#ff0000;"></i></div>
      </div>
      <div class="cc-body">
        <div class="cc-subject">${q.subject || 'Quiz'}</div>
        <h4>${q.name}</h4>
        ${q.liveLabel ? `<span class="lc-label"><i class="fa-solid fa-tag"></i> ${q.liveLabel}</span>` : ''}
      </div>
      <div class="cc-meta">
        <span class="lc-countdown">${formatCountdown(q.liveEnd)}</span>
        <span class="lc-start"><i class="fa-solid fa-play"></i> Start</span>
      </div>
    </div>
  `;
  }).join('');
  
  // Add click handlers to open quiz from main list
  liveRail.querySelectorAll('.live-card').forEach((card) => {
    card.addEventListener('click', () => {
      const quizId = card.dataset.quizId;
      const quiz = LIVE_QUIZZES.get(quizId);
      if (quiz) {
        const target = [...document.querySelectorAll('.quiz-card')].find(
          (c) => (c.querySelector('h3') || {}).textContent?.trim() === quiz.name
        );
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Simulate a click to open the quiz
          setTimeout(() => {
            target.click();
          }, 300);
        }
      }
    });
  });
  
  // Update countdown every 30 seconds
  const countdownInterval = setInterval(() => {
    liveRail.querySelectorAll('.live-card').forEach((card) => {
      const quizId = card.dataset.quizId;
      const quiz = LIVE_QUIZZES.get(quizId);
      if (quiz) {
        const countdown = card.querySelector('.lc-countdown');
        if (countdown) {
          countdown.textContent = formatCountdown(quiz.liveEnd);
        }
      }
    });
  }, 30000);
}

// ------------------------------------------------------------------------
// Scan quiz cards: attach LIVE badge + countdown + pin toggle.
// ------------------------------------------------------------------------
console.log('[quiz-live] script loaded and running');

function scanQuizCards() {
  const cards = document.querySelectorAll('.quiz-card:not([data-ql-scanned])');
  if (cards.length) console.log(`[quiz-live] found ${cards.length} unscanned .quiz-card element(s)`);
  cards.forEach((card) => {
    card.setAttribute('data-ql-scanned', '1');
    const nameEl = card.querySelector('h3');
    const name = nameEl ? nameEl.textContent.trim() : null;
    if (!name) return;

    getQuizByName(name).then((q) => {
      if (!q) { console.warn(`[quiz-live] no Firestore quiz doc matched card name: "${name}"`); return; }
      if (q.liveStart || q.liveEnd) {
        console.log(`[quiz-live] "${name}" liveStatus=${liveStatus(q)} liveStart=${q.liveStart} liveEnd=${q.liveEnd}`);
      }
      
      // Track live quizzes for the live section
      LIVE_QUIZZES.set(q.id, { 
        id: q.id, 
        name, 
        liveEnd: q.liveEnd, 
        subject: q.subject,
        liveStart: q.liveStart,
        liveLabel: q.liveLabel
      });
      renderLiveSection();

      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

      if (liveStatus(q) === 'live') {
        const badge = document.createElement('div');
        badge.className = 'ql-live-badge';
        badge.innerHTML = '<span class="ql-live-dot"></span>Live';
        card.appendChild(badge);

        const countdown = document.createElement('div');
        countdown.className = 'ql-live-countdown';
        countdown.textContent = formatCountdown(q.liveEnd);
        card.appendChild(countdown);
        setInterval(() => { countdown.textContent = formatCountdown(q.liveEnd); }, 30000);
      }

      // Only show pin button on live quizzes
      if (liveStatus(q) === 'live') {
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'ql-pin-btn';
        const setPinVisual = () => {
          const isPinned = PERSONAL_PINS.has(q.id);
          pinBtn.classList.toggle('pinned', isPinned);
          pinBtn.innerHTML = `<i class="fa-solid fa-thumbtack"></i>`;
          pinBtn.title = isPinned ? 'Unpin this quiz' : 'Pin this quiz';
        };
        setPinVisual();
        pinBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          await togglePersonalPin(q.id);
          setPinVisual();
        });
        card.appendChild(pinBtn);
      }
    });
  });
}

new MutationObserver(() => {
  scanQuizCards();
}).observe(document.body, { childList: true, subtree: true });
scanQuizCards();
loadPersonalPins();

// One-off diagnostic: total .quiz-card count on the page 2s after load,
// regardless of scan state — helps tell "wrong selector" apart from
// "cards render after this ran".
setTimeout(() => {
  console.log(`[quiz-live] diagnostic: total .quiz-card elements on page = ${document.querySelectorAll('.quiz-card').length}`);
}, 2000);
