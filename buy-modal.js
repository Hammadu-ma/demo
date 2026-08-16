/* ============================================================================
   buy-modal.js — "Buy this offer" flow (manual bank-transfer verification)

   WHAT THIS DOES
   - Watches the existing Package (Exclusive Offer) details overlay
     (#packageOverlayCard) and, whenever it renders, injects a "Buy" button
     right next to the existing "View this offer's quizzes" CTA (.pkd-cta-btn).
   - Tapping Buy opens a second modal showing:
       - Your bank/account number (with a Copy button)
       - The exact amount for THAT offer (read straight from the overlay's
         own price element, so it always matches what the student sees)
       - A "Sender name" text field
       - A receipt image upload (camera or file picker)
   - On submit: uploads the receipt to Firebase Storage, then writes a
     Firestore doc to `paymentSubmissions/{autoId}` with the offer info,
     sender name, receipt URL, and student identity. Status starts as
     "pending" so you can review + approve in your admin panel.

   WHY A SEPARATE FILE
   The rest of the app bundle is obfuscated/minified, so rather than risk
   corrupting it, this file works purely off stable CSS class names/DOM
   structure that the overlay already exposes. It doesn't require editing
   any of the existing menus/*.js files.

   ============================================================================
   INTEGRATION — 2 steps
   ============================================================================
   1) Add this line in index.html, right after your other <script src="menus/...">
      tags (order relative to others doesn't matter, but it must load AFTER
      Firebase is initialized elsewhere in the app):

        <script src="menus/buy-modal.js" defer></script>

   2) Fill in the CONFIG block below (account number/name, and confirm the
      studentId lookup matches how the rest of the app identifies the
      logged-in student — see getCurrentStudent() at the bottom, it tries a
      few common patterns and you can point it at the right one).

   That's it — no other files need to change.
   ============================================================================ */

(function () {
  'use strict';

  // ------------------------------------------------------------------------
  // CONFIG — edit these
  // ------------------------------------------------------------------------
  const CONFIG = {
    accountNumber: '1000000000000',      // <-- put your real account number here
    accountName: 'Your Name / Bank Name', // <-- shown under the account number
    bankNote: 'Send the exact amount shown below, then upload your receipt.',
    firestoreCollection: 'paymentSubmissions',
    storageFolder: 'payment-receipts',
  };

  // ------------------------------------------------------------------------
  // Student identity — adjust this if your app stores it differently.
  // Tries, in order: window.currentStudent / window.__studentId, then a few
  // common localStorage keys. Falls back to "unknown" (still submits, but
  // flag these for manual matching in your admin panel).
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
        _rawLocalStorageMatch: Object.keys(found).length ? found : undefined,
      };
    } catch (e) {
      return { id: null, name: null };
    }
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

    .bm-overlay {
      position: fixed; inset: 0; z-index: 10000;
      background: rgba(10, 14, 12, .55);
      backdrop-filter: blur(4px);
      display: flex; align-items: flex-end; justify-content: center;
      opacity: 0; visibility: hidden;
      transition: opacity .22s ease, visibility .22s ease;
    }
    .bm-overlay.show { opacity: 1; visibility: visible; }
    @media (min-width: 640px) {
      .bm-overlay { align-items: center; }
    }
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
    @media (min-width: 640px) {
      .bm-card { border-radius: 20px; transform: translateY(12px) scale(.98); }
    }
    .bm-overlay.show .bm-card { transform: translateY(0) scale(1); }

    .bm-card h3 {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 20px; font-weight: 700; margin-bottom: 4px;
    }
    .bm-sub { font-size: 13px; color: var(--ink-soft, #666); margin-bottom: 16px; }

    .bm-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 12px 14px; border-radius: 14px;
      background: var(--paper-2, #f4f4f4); margin-bottom: 10px;
    }
    .bm-row .bm-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-faint, #888); font-weight: 700; }
    .bm-row .bm-value { font-size: 15px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
    .bm-copy-btn {
      border: none; background: var(--accent, var(--artery)); color: #fff;
      font-size: 11.5px; font-weight: 700; padding: 7px 12px; border-radius: 10px;
      cursor: pointer; flex: none;
    }
    .bm-amount { font-size: 22px; }

    .bm-field { margin: 14px 0 6px; }
    .bm-field label { display: block; font-size: 12.5px; font-weight: 700; margin-bottom: 6px; }
    .bm-field input[type="text"] {
      width: 100%; padding: 12px 13px; border-radius: 12px;
      border: 1.5px solid var(--card-border, #ddd); font-size: 14px;
      background: var(--paper, #fff); color: inherit; font-family: inherit;
    }
    .bm-upload {
      border: 1.5px dashed var(--card-border, #ccc); border-radius: 14px;
      padding: 16px; text-align: center; cursor: pointer; font-size: 13px;
      color: var(--ink-soft, #666); position: relative; overflow: hidden;
    }
    .bm-upload.has-file { border-style: solid; border-color: var(--accent, var(--artery)); }
    .bm-upload input[type="file"] {
      position: absolute; inset: 0; opacity: 0; cursor: pointer;
    }
    .bm-preview { margin-top: 10px; max-width: 100%; max-height: 160px; border-radius: 10px; display: none; }

    .bm-note { font-size: 11.5px; color: var(--ink-faint, #888); margin: 10px 0 4px; line-height: 1.4; }

    .bm-actions { display: flex; gap: 10px; margin-top: 18px; }
    .bm-btn-cancel {
      flex: 1; padding: 13px; border-radius: 14px; border: 1.5px solid var(--card-border, #ddd);
      background: transparent; color: var(--ink-soft, #666); font-weight: 700; font-size: 13.5px; cursor: pointer;
    }
    .bm-btn-submit {
      flex: 2; padding: 13px; border-radius: 14px; border: none;
      background: var(--accent, var(--artery)); color: #fff; font-weight: 700; font-size: 13.5px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .bm-btn-submit:disabled { opacity: .55; cursor: not-allowed; }
    .bm-spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
      animation: bm-spin .7s linear infinite;
    }
    @keyframes bm-spin { to { transform: rotate(360deg); } }

    .bm-success { text-align: center; padding: 10px 0 4px; }
    .bm-success i { font-size: 40px; color: #2fae61; margin-bottom: 10px; display: block; }
    .bm-error { color: #d34848; font-size: 12.5px; margin-top: 8px; display: none; }
    .bm-error.show { display: block; }
  `;
  document.head.appendChild(style);

  // ------------------------------------------------------------------------
  // Build the Buy modal DOM (created once, reused)
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

        <div class="bm-row">
          <div>
            <div class="bm-label">Account number</div>
            <div class="bm-value" id="bmAccountNumber">${CONFIG.accountNumber}</div>
          </div>
          <button type="button" class="bm-copy-btn" id="bmCopyBtn">Copy</button>
        </div>
        <div class="bm-note" style="margin-top:-4px;">${CONFIG.accountName}</div>
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
          <p class="bm-sub">We'll review your payment and unlock the offer shortly.</p>
        </div>
        <div class="bm-actions">
          <button type="button" class="bm-btn-submit" id="bmDoneBtn"><span>Done</span></button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let activeOffer = null; // { name, price, priceRaw }
  let selectedFile = null;

  function openModal(offer) {
    activeOffer = offer;
    selectedFile = null;
    overlay.querySelector('#bmStep1').style.display = '';
    overlay.querySelector('#bmStep2').style.display = 'none';
    overlay.querySelector('#bmOfferName').textContent = offer.name || 'Exclusive Offer';
    overlay.querySelector('#bmAmount').textContent = offer.price || '—';
    overlay.querySelector('#bmSenderName').value = '';
    overlay.querySelector('#bmFileInput').value = '';
    overlay.querySelector('#bmUploadBox').classList.remove('has-file');
    overlay.querySelector('#bmUploadLabel').innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>&nbsp; Tap to upload a screenshot or photo';
    overlay.querySelector('#bmPreview').style.display = 'none';
    const err = overlay.querySelector('#bmError');
    err.classList.remove('show');
    err.textContent = '';
    overlay.classList.add('show');
  }

  function closeModal() {
    overlay.classList.remove('show');
  }

  overlay.querySelector('#bmCancelBtn').addEventListener('click', closeModal);
  overlay.querySelector('#bmDoneBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  overlay.querySelector('#bmCopyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(CONFIG.accountNumber).then(() => {
      const btn = overlay.querySelector('#bmCopyBtn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1400);
    });
  });

  overlay.querySelector('#bmFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    selectedFile = file;
    overlay.querySelector('#bmUploadBox').classList.add('has-file');
    overlay.querySelector('#bmUploadLabel').innerHTML = `<i class="fa-solid fa-check"></i>&nbsp; ${file.name}`;
    const preview = overlay.querySelector('#bmPreview');
    const reader = new FileReader();
    reader.onload = (ev) => {
      preview.src = ev.target.result;
      preview.style.display = 'block';
    };
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
    if (!selectedFile) return showError('Please upload your payment receipt.');
    if (typeof firebase === 'undefined' || !firebase.firestore || !firebase.storage) {
      return showError('Payment system unavailable right now. Please try again shortly.');
    }

    const submitBtn = overlay.querySelector('#bmSubmitBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="bm-spinner"></span><span>Submitting…</span>';

    try {
      const student = getCurrentStudent();
      const ts = Date.now();
      const safeName = selectedFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `${CONFIG.storageFolder}/${ts}_${safeName}`;

      const storageRef = firebase.storage().ref(storagePath);
      const snap = await storageRef.put(selectedFile);
      const receiptUrl = await snap.ref.getDownloadURL();

      await firebase.firestore().collection(CONFIG.firestoreCollection).add({
        offerName: activeOffer.name || null,
        offerPrice: activeOffer.price || null,
        senderName,
        receiptUrl,
        studentId: student.id || null,
        studentName: student.name || null,
        status: 'pending',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      overlay.querySelector('#bmStep1').style.display = 'none';
      overlay.querySelector('#bmStep2').style.display = '';
    } catch (e) {
      console.error('[buy-modal] submission failed', e);
      showError('Something went wrong submitting your payment. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Submit</span>';
    }
  });

  // ------------------------------------------------------------------------
  // Inject the "Buy" button into the existing offer overlay whenever it
  // renders. Uses a MutationObserver so it works regardless of when/how
  // the app's own (obfuscated) code populates #packageOverlayCard.
  // ------------------------------------------------------------------------
  function injectBuyButton(overlayCard) {
    if (!overlayCard || overlayCard.querySelector('.bm-cta-btn')) return; // already injected
    const viewBtn = overlayCard.querySelector('.pkd-cta-btn');
    if (!viewBtn) return;

    const nameEl = overlayCard.querySelector('h3');
    const priceEl = overlayCard.querySelector('.pkd-price-now');
    const offerName = nameEl ? nameEl.textContent.trim() : 'Exclusive Offer';
    const offerPrice = priceEl ? priceEl.textContent.trim() : '';

    const buyBtn = document.createElement('button');
    buyBtn.type = 'button';
    buyBtn.className = 'bm-cta-btn';
    buyBtn.innerHTML = '<i class="fa-solid fa-receipt"></i>&nbsp; Buy this offer';
    buyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal({ name: offerName, price: offerPrice });
    });

    viewBtn.insertAdjacentElement('afterend', buyBtn);
  }

  const overlayCardEl = document.getElementById('packageOverlayCard');
  if (overlayCardEl) {
    const observer = new MutationObserver(() => injectBuyButton(overlayCardEl));
    observer.observe(overlayCardEl, { childList: true, subtree: true });
    // In case it's already populated when this script runs
    injectBuyButton(overlayCardEl);
  }
})();
