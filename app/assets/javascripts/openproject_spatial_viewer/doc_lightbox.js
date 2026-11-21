/**
 * Lightbox for image attachments on OpenProject document pages: clicking an
 * image in the attachment list opens it over the page, with previous / next /
 * close buttons (and the arrow keys / Esc), instead of a new browser tab.
 */
(function () {
  'use strict';
  if (window.__svDocLightbox) return;
  window.__svDocLightbox = true;

  var IMG_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i;
  var LINK_SEL = 'a.op-file-list--item-action';
  var overlay = null, imgEl, capEl, cntEl, prevBtn, nextBtn, items = [], idx = 0;

  function nameOf(a) {
    var t = a.querySelector('.op-file-list--item-title');
    return ((t && (t.getAttribute('title') || t.textContent)) || a.getAttribute('href') || '').trim();
  }

  function isImage(a) { return IMG_RE.test(nameOf(a)); }

  function onDocumentPage() { return /\/documents\//.test(window.location.pathname); }

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'sv-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML =
      '<button type="button" class="sv-lb-btn sv-lb-close" aria-label="Close" title="Close (Esc)">×</button>' +
      '<button type="button" class="sv-lb-btn sv-lb-prev" aria-label="Previous" title="Previous (←)">‹</button>' +
      '<img class="sv-lb-img" alt="">' +
      '<button type="button" class="sv-lb-btn sv-lb-next" aria-label="Next" title="Next (→)">›</button>' +
      '<div class="sv-lb-bar"><span class="sv-lb-cap"></span><span class="sv-lb-count"></span></div>';
    imgEl = overlay.querySelector('.sv-lb-img');
    capEl = overlay.querySelector('.sv-lb-cap');
    cntEl = overlay.querySelector('.sv-lb-count');
    prevBtn = overlay.querySelector('.sv-lb-prev');
    nextBtn = overlay.querySelector('.sv-lb-next');
    overlay.querySelector('.sv-lb-close').addEventListener('click', close);
    prevBtn.addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
    nextBtn.addEventListener('click', function (e) { e.stopPropagation(); go(1); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  }

  function show() {
    var it = items[idx];
    imgEl.src = it.href;
    imgEl.alt = it.name;
    capEl.textContent = it.name;
    cntEl.textContent = (idx + 1) + ' / ' + items.length;
    var single = items.length < 2;
    prevBtn.style.display = nextBtn.style.display = single ? 'none' : '';
    // warm the neighbours so stepping through is quick
    [idx - 1, idx + 1].forEach(function (j) {
      if (j >= 0 && j < items.length) { var p = new Image(); p.src = items[j].href; }
    });
  }

  function go(d) {
    if (items.length < 2) return;
    idx = (idx + d + items.length) % items.length;
    show();
  }

  function onKey(e) {
    if (!overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); }
  }

  function open(list, start) {
    items = list; idx = start;
    if (!overlay) build();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    show();
  }

  function close() {
    if (!overlay) return;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.removeEventListener('keydown', onKey, true);
    imgEl.removeAttribute('src');
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (!onDocumentPage()) return;
    var a = e.target.closest && e.target.closest(LINK_SEL);
    if (!a || !isImage(a)) return;
    var scope = a.closest('opce-attachments') || document;
    var links = Array.prototype.filter.call(scope.querySelectorAll(LINK_SEL), isImage);
    var list = links.map(function (l) { return { href: l.href, name: nameOf(l) }; });
    var start = links.indexOf(a);
    if (start < 0) return;
    e.preventDefault();
    e.stopPropagation();
    open(list, start);
  }, true);
})();
