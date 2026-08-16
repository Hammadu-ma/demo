/* ============================================================================
   buy-modal.js — "Buy this offer" flow (manual bank-transfer verification)

   IMPORTANT: this is an ES module (loaded with <script type="module">) since
   it talks to Firebase directly using the same modular v10 SDK the rest of
   the app uses. It initializes its OWN Firebase app instance — safe to do
   alongside the app's own instance, Firebase allows multiple named apps,
   and this only ever reads/writes collections this file owns
   (paymentSubmissions) or reads price fields from (modules/subjects/quizzes).

   WHAT THIS DOES
   - Watches the existing Package (Exclusive Offer) details overlay
     (#packageOverlayCard) and, whenever it renders, injects a "Buy" button
     next to "View this offer's quizzes" (.pkd-cta-btn) — but only if the
     student doesn't already own it (i.e. the button still has the `locked`
     class).
   - Intercepts taps on ANY locked card — bundles, modules, subjects,
     quizzes, pills — and shows an overlay that reuses the app's own
     `.lock-overlay` CSS classes (identical icon pop/float animation), with
     a Buy button that opens the payment modal for that specific item.
   - Price shown for a locked bundle card comes straight from its own
     `.pk-price-now` element (already authored per-package). Price for a
     locked module/subject/quiz card is looked up live from Firestore:
       1. That item's own `price` field (matched by name — see LIMITATION
          below), if set.
       2. Otherwise the global uniform default for that item type, from
          `settings/pricing` (set in the admin Pricing panel).
       3. Otherwise "Contact for price".
   - On submit: uploads the receipt to Firebase Storage, then writes a
     Firestore doc to `paymentSubmissions/{autoId}` with the item info,
     sender name, receipt URL, and student identity. Status starts as
     "pending" so you can review + approve in the admin Payments panel.

   LIMITATION — name-based matching
   The rest of the app bundle is obfuscated, so this script can only read
   what's already in the rendered DOM (names, not Firestore doc IDs). Price
   lookups therefore match by exact item name. If two modules/subjects/
   quizzes share the same name, whichever matches first wins. This doesn't
   affect bundle/package cards, which already carry their own price text.

   ============================================================================
   INTEGRATION
   ============================================================================
   In index.html, this must be loaded as a module (already updated for you):

     <script type="module" src="menus/buy-modal.js"></script>

   Fill in the CONFIG block below (account number/name), and confirm
   getCurrentStudent() matches how the rest of the app identifies the
   logged-in student.
   ============================================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getFirestore, collection, query, where, orderBy, limit, getDocs, getDoc, doc,
  collectionGroup, addDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

// Same Firebase project as the rest of the app / the admin panel.
const firebaseConfig = {
  apiKey: 'AIzaSyBXFcbQlTB1mXBsHd_bxnHdgS7dmHK_x3k',
  authDomain: 'exam-d9415.firebaseapp.com',
  projectId: 'exam-d9415',
  storageBucket: 'exam-d9415.firebasestorage.app',
  messagingSenderId: '258742955197',
  appId: '1:258742955197:web:a8e6a179f9e7c23c5b5bd4',
};
const fbApp = initializeApp(firebaseConfig, 'buyModal');
const db = getFirestore(fbApp);

// ------------------------------------------------------------------------
// CONFIG — edit these
// ------------------------------------------------------------------------
const CONFIG = {
  bankNote: 'Send the exact amount shown below to one of the accounts, then upload your receipt.',
  firestoreCollection: 'paymentSubmissions',
};

// ------------------------------------------------------------------------
// Bank accounts — fetched from Firestore (managed in the admin "Bank
// Accounts" panel). Cached for the session; refetched each time the modal
// opens fresh isn't necessary since accounts rarely change mid-session.
// ------------------------------------------------------------------------
let BANK_ACCOUNTS = null;
let BANK_ACCOUNTS_PROMISE = null;
let selectedBankAccountId = null;

async function getBankAccounts() {
  if (BANK_ACCOUNTS) return BANK_ACCOUNTS;
  if (!BANK_ACCOUNTS_PROMISE) {
    BANK_ACCOUNTS_PROMISE = (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'bankAccounts'), orderBy('order', 'asc')));
        BANK_ACCOUNTS = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      } catch (e) {
        BANK_ACCOUNTS = [];
      }
      return BANK_ACCOUNTS;
    })();
  }
  return BANK_ACCOUNTS_PROMISE;
}

// ------------------------------------------------------------------------
// Telegram notifications — bot token + chat ID are stored in Firestore
// (settings/telegram), editable anytime from the admin panel's "Telegram"
// button, rather than hardcoded here. Best-effort: if this fails, the
// submission itself has already succeeded and is safe in Firestore either
// way — the admin panel's Payments list is always the source of truth.
// ------------------------------------------------------------------------
let TELEGRAM_SETTINGS_PROMISE = null;
async function getTelegramSettings() {
  if (!TELEGRAM_SETTINGS_PROMISE) {
    TELEGRAM_SETTINGS_PROMISE = (async () => {
      try {
        const snap = await getDoc(doc(db, 'settings', 'telegram'));
        return snap.exists() ? snap.data() : {};
      } catch (e) {
        return {};
      }
    })();
  }
  return TELEGRAM_SETTINGS_PROMISE;
}

async function sendReceiptToTelegram({ offer, senderName, file, student, bankAccount }) {
  const settings = await getTelegramSettings();
  if (!settings.botToken || !settings.chatId) {
    throw new Error('Telegram is not configured yet — set it up in the admin panel first.');
  }

  const lines = [
    `\uD83E\uDE99 New payment submission`,
    `Item: ${offer.name || '—'} (${offer.type || 'package'})`,
    `Amount: ${offer.price || '—'}`,
    `Sender: ${senderName}`,
    bankAccount ? `Sent to: ${bankAccount.bankName || ''} · ${bankAccount.accountNumber || ''}` : null,
    `Student: ${student.name || 'Unknown'}${student.id ? ' (' + student.id + ')' : ' — no student ID captured'}`,
  ].filter(Boolean).join('\n');

  const form = new FormData();
  form.append('chat_id', settings.chatId);
  form.append('caption', lines);
  form.append('photo', file, file.name || 'receipt.jpg');

  const res = await fetch(`https://api.telegram.org/bot${settings.botToken}/sendPhoto`, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Telegram rejected the upload');

  const photos = data.result && data.result.photo;
  const largest = photos && photos.length ? photos[photos.length - 1] : null;
  return {
    telegramFileId: largest ? largest.file_id : null,
    telegramMessageId: data.result ? data.result.message_id : null,
  };
}

// ------------------------------------------------------------------------
// Student identity — adjust this if your app stores it differently.
// ------------------------------------------------------------------------
function getCurrentStudent() {
  try {
    if (window.currentStudent && (window.currentStudent.id || window.currentStudent.name)) {
      return {
        id: window.currentStudent.id || null,
        name: window.currentStudent.name || window.currentStudent.displayName || null,
      };
    }
    if (window.__studentId) return { id: window.__studentId, name: window.__studentName || null };

    const lsKeys = ['studentId', 'alifmed_student_id', 'secretKey', 'alifmed_secret_key', 'studentName'];
    const found = {};
    lsKeys.forEach((k) => {
      const v = localStorage.getItem(k);
      if (v) found[k] = v;
    });
    return {
      id: found.studentId || found.alifmed_student_id || found.secretKey || found.alifmed_secret_key || null,
      name: found.studentName || null,
    };
  } catch (e) {
    return { id: null, name: null };
  }
}

// ------------------------------------------------------------------------
// The student's own pending submissions — so a card they've already paid
// for shows "Pending review" instead of prompting Buy again. Keyed by
// "type::name" since that's all we can read off the DOM (see LIMITATION
// above). Refreshed on load and updated optimistically on submit.
// ------------------------------------------------------------------------
const PENDING_KEYS = new Set();
let PENDING_LOADED_FOR = null;

async function loadPendingSubmissions() {
  const student = getCurrentStudent();
  if (!student.id || PENDING_LOADED_FOR === student.id) return;
  PENDING_LOADED_FOR = student.id;
  try {
    const snap = await getDocs(query(
      collection(db, 'paymentSubmissions'),
      where('studentId', '==', student.id),
      where('status', '==', 'pending'),
    ));
    snap.docs.forEach((d) => {
      const data = d.data();
      PENDING_KEYS.add(`${data.offerType || 'package'}::${(data.offerName || '').trim()}`);
    });
  } catch (e) {
    // Best-effort — if this fails, cards just won't show the pending state
    // until reload; submission itself is unaffected.
  }
}
loadPendingSubmissions();

function isPending(type, name) {
  return PENDING_KEYS.has(`${type}::${(name || '').trim()}`);
}

// ------------------------------------------------------------------------
// Price lookup — modules/subjects/quizzes, with global-default fallback.
// Cached per (type,name) for the session so repeated taps don't re-query.
// ------------------------------------------------------------------------
const PRICE_CACHE = new Map();
let PRICING_SETTINGS = null;
let PRICING_SETTINGS_PROMISE = null;

async function getPricingSettings() {
  if (PRICING_SETTINGS) return PRICING_SETTINGS;
  if (!PRICING_SETTINGS_PROMISE) {
    PRICING_SETTINGS_PROMISE = (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'settings'), where('__name__', '==', 'pricing'), limit(1)));
        PRICING_SETTINGS = snap.docs.length ? snap.docs[0].data() : {};
      } catch (e) {
        PRICING_SETTINGS = {};
      }
      return PRICING_SETTINGS;
    })();
  }
  return PRICING_SETTINGS_PROMISE;
}

const TYPE_TO_COLLECTION = { module: 'modules', subject: 'subjects', quiz: null }; // quiz uses collectionGroup
const TYPE_TO_UNIFORM_FIELD = {
  module: 'moduleUniformPrice',
  subject: 'subjectUniformPrice',
  quiz: 'quizUniformPrice',
};

async function lookupPrice(type, name) {
  const cacheKey = `${type}::${name}`;
  if (PRICE_CACHE.has(cacheKey)) return PRICE_CACHE.get(cacheKey);

  let price = null;
  try {
    if (type === 'quiz') {
      const snap = await getDocs(query(collectionGroup(db, 'quizzes'), where('name', '==', name), limit(1)));
      if (snap.docs.length && snap.docs[0].data().price) price = snap.docs[0].data().price;
    } else {
      const collName = TYPE_TO_COLLECTION[type];
      if (collName) {
        const snap = await getDocs(query(collection(db, collName), where('name', '==', name), limit(1)));
        if (snap.docs.length && snap.docs[0].data().price) price = snap.docs[0].data().price;
      }
    }
  } catch (e) {
    // Firestore query failed (e.g. missing index for a filtered collectionGroup
    // query) — fall through to the global default below.
  }

  if (!price) {
    const settings = await getPricingSettings();
    const field = TYPE_TO_UNIFORM_FIELD[type];
    if (field && settings[field]) price = settings[field];
  }

  const result = price || 'Contact for price';
  PRICE_CACHE.set(cacheKey, result);
  return result;
}

// ------------------------------------------------------------------------
// Styles (scoped, injected once)
// ------------------------------------------------------------------------
const style = document.createElement('style');
style.textContent = `
  .bm-cta-btn {
    width: 100%;
    margin-top: 10px;
    padding: 13px 16px;
    border-radius: 14px;
    border: 1.5px solid var(--accent, var(--artery));
    background: transparent;
    color: var(--accent, var(--artery));
    font-size: 13.5px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
    transition: transform .18s ease, background .18s ease;
    font-family: inherit;
  }
  .bm-cta-btn:hover { transform: translateY(-1px); background: color-mix(in srgb, var(--accent, var(--artery)) 10%, transparent); }

  .bm-pending-badge {
    width: 100%; margin-top: 10px; padding: 12px 16px; border-radius: 14px;
    background: color-mix(in srgb, #d99a2b 14%, transparent);
    color: #a3690f; font-size: 13px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; gap: 8px;
  }

  .bm-overlay {
    position: fixed; inset: 0; z-index: 10000;
    background: rgba(10, 14, 12, .55);
    backdrop-filter: blur(4px);
    display: flex; align-items: flex-end; justify-content: center;
    opacity: 0; visibility: hidden;
    transition: opacity .22s ease, visibility .22s ease;
  }
  .bm-overlay.show { opacity: 1; visibility: visible; }
  @media (min-width: 640px) { .bm-overlay { align-items: center; } }
  .bm-card {
    width: 100%; max-width: 440px;
    max-height: 92vh; overflow-y: auto;
    background: var(--card, #fff);
    border-radius: 22px 22px 0 0;
    padding: 22px 20px 26px;
    transform: translateY(24px);
    transition: transform .22s ease;
    font-family: 'Source Sans 3', -apple-system, BlinkMacSystemFont, sans-serif;
    color: var(--ink, #1a1a1a);
  }
  @media (min-width: 640px) { .bm-card { border-radius: 20px; transform: translateY(12px) scale(.98); } }
  .bm-overlay.show .bm-card { transform: translateY(0) scale(1); }

  .bm-card h3 { font-family: 'Fraunces', Georgia, serif; font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .bm-sub { font-size: 13px; color: var(--ink-soft, #666); margin-bottom: 16px; }

  .bm-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 12px 14px; border-radius: 14px;
    background: var(--paper-2, #f4f4f4); margin-bottom: 10px;
  }
  .bm-row .bm-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-faint, #888); font-weight: 700; }
  .bm-row .bm-value { font-size: 15px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
  .bm-copy-btn { border: none; background: var(--accent, var(--artery)); color: #fff; font-size: 11.5px; font-weight: 700; padding: 7px 12px; border-radius: 10px; cursor: pointer; flex: none; }
  .bm-amount { font-size: 22px; }

  .bm-field { margin: 14px 0 6px; }
  .bm-field label { display: block; font-size: 12.5px; font-weight: 700; margin-bottom: 6px; }
  .bm-field input[type="text"] { width: 100%; padding: 12px 13px; border-radius: 12px; border: 1.5px solid var(--card-border, #ddd); font-size: 14px; background: var(--paper, #fff); color: inherit; font-family: inherit; }
  .bm-upload { border: 1.5px dashed var(--card-border, #ccc); border-radius: 14px; padding: 16px; text-align: center; cursor: pointer; font-size: 13px; color: var(--ink-soft, #666); position: relative; overflow: hidden; }
  .bm-upload.has-file { border-style: solid; border-color: var(--accent, var(--artery)); }
  .bm-upload input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .bm-preview { margin-top: 10px; max-width: 100%; max-height: 160px; border-radius: 10px; display: none; }

  .bm-note { font-size: 11.5px; color: var(--ink-faint, #888); margin: 10px 0 4px; line-height: 1.4; }

  .bm-bank-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
  .bm-bank-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-radius: 14px;
    border: 1.5px solid var(--card-border, #ddd); background: var(--paper, #fff);
    cursor: pointer; transition: border-color .15s ease, background .15s ease;
  }
  .bm-bank-row.selected { border-color: var(--accent, var(--artery)); background: color-mix(in srgb, var(--accent, var(--artery)) 8%, transparent); }
  .bm-bank-logo { width: 34px; height: 34px; border-radius: 8px; object-fit: contain; background: #fff; border: 1px solid var(--card-border, #eee); flex: none; }
  .bm-bank-info { flex: 1; min-width: 0; }
  .bm-bank-name { font-size: 13.5px; font-weight: 700; }
  .bm-bank-number { font-size: 12.5px; font-family: 'JetBrains Mono', monospace; color: var(--ink-soft, #666); display: flex; align-items: center; gap: 6px; }
  .bm-bank-copy { border: none; background: none; color: var(--accent, var(--artery)); font-size: 11px; font-weight: 700; cursor: pointer; padding: 2px 4px; flex: none; }
  .bm-bank-radio { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--card-border, #ccc); flex: none; display: flex; align-items: center; justify-content: center; }
  .bm-bank-row.selected .bm-bank-radio { border-color: var(--accent, var(--artery)); }
  .bm-bank-row.selected .bm-bank-radio::after { content: ''; width: 9px; height: 9px; border-radius: 50%; background: var(--accent, var(--artery)); }

  .bm-actions { display: flex; gap: 10px; margin-top: 18px; }
  .bm-btn-cancel { flex: 1; padding: 13px; border-radius: 14px; border: 1.5px solid var(--card-border, #ddd); background: transparent; color: var(--ink-soft, #666); font-weight: 700; font-size: 13.5px; cursor: pointer; }
  .bm-btn-submit { flex: 2; padding: 13px; border-radius: 14px; border: none; background: var(--accent, var(--artery)); color: #fff; font-weight: 700; font-size: 13.5px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
  .bm-btn-submit:disabled { opacity: .55; cursor: not-allowed; }
  .bm-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; animation: bm-spin .7s linear infinite; }
  @keyframes bm-spin { to { transform: rotate(360deg); } }

  .bm-success { text-align: center; padding: 10px 0 4px; }
  .bm-success i { font-size: 40px; color: #2fae61; margin-bottom: 10px; display: block; }
  .bm-error { color: #d34848; font-size: 12.5px; margin-top: 8px; display: none; }
  .bm-error.show { display: block; }
`;
document.head.appendChild(style);

// ------------------------------------------------------------------------
// Payment modal DOM (created once, reused)
// ------------------------------------------------------------------------
const overlay = document.createElement('div');
overlay.className = 'bm-overlay';
overlay.innerHTML = `
  <div class="bm-card" role="dialog" aria-modal="true">
    <div id="bmStep1">
      <h3>Complete your payment</h3>
      <div class="bm-sub" id="bmOfferName"></div>

      <div class="bm-row">
        <div>
          <div class="bm-label">Amount to send</div>
          <div class="bm-value bm-amount" id="bmAmount"></div>
        </div>
      </div>

      <div class="bm-field">
        <label>Send to</label>
        <div class="bm-bank-list" id="bmBankList"></div>
      </div>
      <div class="bm-note">${CONFIG.bankNote}</div>

      <div class="bm-field">
        <label for="bmSenderName">Sender name (as it appears on the transfer)</label>
        <input type="text" id="bmSenderName" placeholder="e.g. Ahmed Yusuf" autocomplete="off" />
      </div>

      <div class="bm-field">
        <label>Payment receipt</label>
        <div class="bm-upload" id="bmUploadBox">
          <span id="bmUploadLabel"><i class="fa-solid fa-cloud-arrow-up"></i>&nbsp; Tap to upload a screenshot or photo</span>
          <input type="file" id="bmFileInput" accept="image/*" capture="environment" />
        </div>
        <img class="bm-preview" id="bmPreview" alt="Receipt preview" />
      </div>

      <div class="bm-error" id="bmError"></div>

      <div class="bm-actions">
        <button type="button" class="bm-btn-cancel" id="bmCancelBtn">Cancel</button>
        <button type="button" class="bm-btn-submit" id="bmSubmitBtn"><span>Submit</span></button>
      </div>
    </div>

    <div id="bmStep2" style="display:none;">
      <div class="bm-success">
        <i class="fa-solid fa-circle-check"></i>
        <h3>Submitted</h3>
        <p class="bm-sub">We'll review your payment and unlock it shortly.</p>
      </div>
      <div class="bm-actions">
        <button type="button" class="bm-btn-submit" id="bmDoneBtn"><span>Done</span></button>
      </div>
    </div>
  </div>
`;
document.body.appendChild(overlay);

let activeOffer = null; // { name, price, type }
let selectedFile = null;

function openModal(offer) {
  activeOffer = offer;
  selectedFile = null;
  selectedBankAccountId = null;
  overlay.querySelector('#bmStep1').style.display = '';
  overlay.querySelector('#bmStep2').style.display = 'none';
  overlay.querySelector('#bmOfferName').textContent = offer.name || 'This item';
  overlay.querySelector('#bmAmount').textContent = offer.price || 'Contact for price';
  overlay.querySelector('#bmSenderName').value = '';
  overlay.querySelector('#bmFileInput').value = '';
  overlay.querySelector('#bmUploadBox').classList.remove('has-file');
  overlay.querySelector('#bmUploadLabel').innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>&nbsp; Tap to upload a screenshot or photo';
  overlay.querySelector('#bmPreview').style.display = 'none';
  const err = overlay.querySelector('#bmError');
  err.classList.remove('show');
  err.textContent = '';
  overlay.classList.add('show');

  const bankList = overlay.querySelector('#bmBankList');
  bankList.innerHTML = `<div class="bm-note">Loading accounts…</div>`;
  getBankAccounts().then((accounts) => {
    if (!accounts.length) {
      bankList.innerHTML = `<div class="bm-note">No bank accounts set up yet — contact support.</div>`;
      return;
    }
    bankList.innerHTML = accounts.map((a) => `
      <div class="bm-bank-row" data-id="${a.id}">
        <img class="bm-bank-logo" src="${a.logoUrl || ''}" onerror="this.style.visibility='hidden'" />
        <div class="bm-bank-info">
          <div class="bm-bank-name">${a.bankName || 'Bank'}</div>
          <div class="bm-bank-number">${a.accountNumber || ''}<button type="button" class="bm-bank-copy" data-copy="${a.accountNumber || ''}">Copy</button></div>
        </div>
        <div class="bm-bank-radio"></div>
      </div>
    `).join('');

    bankList.querySelectorAll('.bm-bank-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('bm-bank-copy')) return;
        selectedBankAccountId = row.dataset.id;
        bankList.querySelectorAll('.bm-bank-row').forEach((r) => r.classList.toggle('selected', r === row));
      });
    });
    bankList.querySelectorAll('.bm-bank-copy').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(btn.dataset.copy).then(() => {
          const original = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = original; }, 1400);
        });
      });
    });
  });
}
function closeModal() { overlay.classList.remove('show'); }

overlay.querySelector('#bmCancelBtn').addEventListener('click', closeModal);
overlay.querySelector('#bmDoneBtn').addEventListener('click', closeModal);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

overlay.querySelector('#bmFileInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  selectedFile = file;
  overlay.querySelector('#bmUploadBox').classList.add('has-file');
  overlay.querySelector('#bmUploadLabel').innerHTML = `<i class="fa-solid fa-check"></i>&nbsp; ${file.name}`;
  const preview = overlay.querySelector('#bmPreview');
  const reader = new FileReader();
  reader.onload = (ev) => { preview.src = ev.target.result; preview.style.display = 'block'; };
  reader.readAsDataURL(file);
});

function showError(msg) {
  const err = overlay.querySelector('#bmError');
  err.textContent = msg;
  err.classList.add('show');
}

overlay.querySelector('#bmSubmitBtn').addEventListener('click', async () => {
  const senderName = overlay.querySelector('#bmSenderName').value.trim();
  const err = overlay.querySelector('#bmError');
  err.classList.remove('show');

  if (!senderName) return showError('Please enter the sender name.');
  if (!selectedBankAccountId) return showError('Please select which account you sent the payment to.');
  if (!selectedFile) return showError('Please upload your payment receipt.');

  const submitBtn = overlay.querySelector('#bmSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="bm-spinner"></span><span>Submitting…</span>';

  try {
    const student = getCurrentStudent();
    const accounts = await getBankAccounts();
    const bankAccount = accounts.find((a) => a.id === selectedBankAccountId);

    const { telegramFileId, telegramMessageId } = await sendReceiptToTelegram({
      offer: activeOffer, senderName, file: selectedFile, student, bankAccount,
    });

    await addDoc(collection(db, CONFIG.firestoreCollection), {
      offerName: activeOffer.name || null,
      offerPrice: activeOffer.price || null,
      offerType: activeOffer.type || 'package',
      senderName,
      bankAccountId: selectedBankAccountId,
      bankName: bankAccount ? bankAccount.bankName : null,
      bankAccountNumber: bankAccount ? bankAccount.accountNumber : null,
      telegramFileId: telegramFileId || null,
      telegramMessageId: telegramMessageId || null,
      studentId: student.id || null,
      studentName: student.name || null,
      status: 'pending',
      createdAt: serverTimestamp(),
    });

    overlay.querySelector('#bmStep1').style.display = 'none';
    overlay.querySelector('#bmStep2').style.display = '';

    PENDING_KEYS.add(`${activeOffer.type || 'package'}::${(activeOffer.name || '').trim()}`);
    if (activeOffer.type === 'package' && overlayCardEl) injectBuyButton(overlayCardEl);
  } catch (e) {
    console.error('[buy-modal] submission failed', e);
    showError('Something went wrong submitting your payment. Please try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Submit</span>';
  }
});

// ------------------------------------------------------------------------
// Bundle overlay Buy button (only shown when NOT already owned)
// ------------------------------------------------------------------------
function injectBuyButton(overlayCard) {
  const viewBtn = overlayCard.querySelector('.pkd-cta-btn');
  const existingBuyBtn = overlayCard.querySelector('.bm-cta-btn');
  const existingPendingBadge = overlayCard.querySelector('.bm-pending-badge');
  if (!viewBtn) return;

  const isLocked = viewBtn.classList.contains('locked');
  if (!isLocked) {
    if (existingBuyBtn) existingBuyBtn.remove();
    if (existingPendingBadge) existingPendingBadge.remove();
    return;
  }

  const nameEl = overlayCard.querySelector('h3');
  const offerName = nameEl ? nameEl.textContent.trim() : 'Exclusive Offer';

  if (isPending('package', offerName)) {
    if (existingBuyBtn) existingBuyBtn.remove();
    if (existingPendingBadge) return; // already showing
    const badge = document.createElement('div');
    badge.className = 'bm-pending-badge';
    badge.innerHTML = '<i class="fa-solid fa-clock"></i>&nbsp; Payment pending review';
    viewBtn.insertAdjacentElement('afterend', badge);
    return;
  }
  if (existingPendingBadge) existingPendingBadge.remove();
  if (existingBuyBtn) return;

  const priceEl = overlayCard.querySelector('.pkd-price-now');
  const offerPrice = priceEl ? priceEl.textContent.trim() : '';

  const buyBtn = document.createElement('button');
  buyBtn.type = 'button';
  buyBtn.className = 'bm-cta-btn';
  buyBtn.innerHTML = '<i class="fa-solid fa-receipt"></i>&nbsp; Buy this offer';
  buyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openModal({ name: offerName, price: offerPrice, type: 'package' });
  });

  viewBtn.insertAdjacentElement('afterend', buyBtn);
}

const overlayCardEl = document.getElementById('packageOverlayCard');
if (overlayCardEl) {
  const observer = new MutationObserver(() => injectBuyButton(overlayCardEl));
  observer.observe(overlayCardEl, { childList: true, subtree: true });
  injectBuyButton(overlayCardEl);
}

// ------------------------------------------------------------------------
// Locked CARDS everywhere — bundles, modules, subjects, quizzes, pills.
// ------------------------------------------------------------------------
const LOCKED_CARD_CONFIGS = [
  { selector: '.module-card.locked', nameSel: '.module-name', priceSel: null, type: 'module', label: 'module' },
  { selector: '.subject-card.locked', nameSel: '.subject-name', priceSel: null, type: 'subject', label: 'subject' },
  { selector: '.quiz-card.locked', nameSel: 'h3', priceSel: null, type: 'quiz', label: 'quiz' },
  { selector: '.pill.locked', nameSel: null, priceSel: null, type: 'quiz', label: 'item' },
];
const LOCKED_CARD_SELECTOR = LOCKED_CARD_CONFIGS.map((c) => c.selector).join(', ');

const pkgLockOverlay = document.createElement('div');
pkgLockOverlay.className = 'lock-overlay';
pkgLockOverlay.id = 'bmPackageLockOverlay';
pkgLockOverlay.innerHTML = `
  <div class="lock-overlay-icons" aria-hidden="true">
    <div class="lock-overlay-icon"><i class="fa-solid fa-lock"></i></div>
    <div class="lock-overlay-icon"><i class="fa-solid fa-receipt"></i></div>
    <div class="lock-overlay-icon"><i class="fa-solid fa-star"></i></div>
  </div>
  <div class="lock-overlay-message" id="bmPkgLockMsg" style="cursor:default;">
    <span id="bmPkgLockMsgText"></span>
    <button type="button" class="bm-cta-btn" id="bmPkgLockBuyBtn" style="margin-top:14px;">
      <i class="fa-solid fa-receipt"></i>&nbsp; Buy this
    </button>
  </div>
  <div class="lock-overlay-hint">Tap anywhere to close</div>
`;
document.body.appendChild(pkgLockOverlay);

let pendingCardOffer = null;

function openPkgLockOverlay(offer) {
  pendingCardOffer = offer;
  const buyBtn = pkgLockOverlay.querySelector('#bmPkgLockBuyBtn');
  if (offer.pending) {
    pkgLockOverlay.querySelector('#bmPkgLockMsgText').textContent = `${offer.name} — your payment is pending review.`;
    buyBtn.style.display = 'none';
  } else {
    pkgLockOverlay.querySelector('#bmPkgLockMsgText').textContent = `${offer.name} is locked.`;
    buyBtn.style.display = '';
    buyBtn.innerHTML = `<i class="fa-solid fa-receipt"></i>&nbsp; Buy this ${offer.label}`;
  }
  pkgLockOverlay.classList.add('show');
}
function closePkgLockOverlay() { pkgLockOverlay.classList.remove('show'); }

pkgLockOverlay.addEventListener('click', (e) => { if (e.target === pkgLockOverlay) closePkgLockOverlay(); });
pkgLockOverlay.querySelector('#bmPkgLockMsg').addEventListener('click', (e) => e.stopPropagation());
pkgLockOverlay.querySelector('#bmPkgLockBuyBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  closePkgLockOverlay();
  if (pendingCardOffer) openModal(pendingCardOffer);
});

async function getCardOfferInfo(card, config) {
  const name = (config.nameSel ? (card.querySelector(config.nameSel) || {}).textContent : card.textContent) || 'This item';
  const trimmedName = name.trim();

  // Bundles already carry their own price text in the DOM — no lookup needed.
  if (config.type === 'package') {
    let price = card.getAttribute('data-price');
    if (!price && config.priceSel) {
      const priceEl = card.querySelector(config.priceSel);
      if (priceEl) price = priceEl.textContent.trim();
    }
    return { name: trimmedName, price: price || 'Contact for price', type: config.type, label: config.label };
  }

  // Modules/subjects/quizzes: data-price attribute wins if present (in case
  // you set one directly on the rendered card), otherwise look it up live.
  const dataPrice = card.getAttribute('data-price');
  const price = dataPrice || await lookupPrice(config.type, trimmedName);
  return { name: trimmedName, price, type: config.type, label: config.label };
}

document.addEventListener(
  'click',
  (e) => {
    // Never touch anything inside a bundle card — that flow is untouched
    // and must always reach the app's own handler (opens the offer modal).
    if (e.target.closest && e.target.closest('.package-card')) return;

    const card = e.target.closest && e.target.closest(LOCKED_CARD_SELECTOR);
    if (!card) return;
    const config = LOCKED_CARD_CONFIGS.find((c) => card.matches(c.selector));
    if (!config) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const name = (config.nameSel ? (card.querySelector(config.nameSel) || {}).textContent : card.textContent) || 'This item';
    const trimmedName = name.trim();

    if (isPending(config.type, trimmedName)) {
      openPkgLockOverlay({ name: trimmedName, price: '', type: config.type, label: config.label, pending: true });
      return;
    }

    // Show instantly with a loading price, then fill in once resolved —
    // keeps the animation snappy instead of waiting on a Firestore round trip.
    openPkgLockOverlay({ name: trimmedName, price: 'Loading…', type: config.type, label: config.label });

    getCardOfferInfo(card, config).then((offer) => {
      pendingCardOffer = offer; // update in case price resolved after tap
      const msgEl = pkgLockOverlay.querySelector('#bmPkgLockMsgText');
      if (pkgLockOverlay.classList.contains('show')) {
        msgEl.textContent = `${offer.name} is locked.`;
      }
    });
  },
  true
);