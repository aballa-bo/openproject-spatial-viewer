/**
 * Layer manager for the SpatialModel edit page: add / remove layer files and
 * poll the server-side conversion status (IFC -> GLB, LAZ/E57 -> LAS).
 */
(function () {
  'use strict';

  function init() {
    var root = document.getElementById('spatialLayerManager');
    if (!root || root.dataset.bound === '1') return;
    root.dataset.bound = '1';

    var createUrl = root.dataset.createUrl;
    var baseUrl = root.dataset.baseUrl;
    var csrf = root.dataset.csrfToken;
    var rows = document.getElementById('layerRows');
    var form = document.getElementById('addLayerForm');
    var btn = document.getElementById('addLayerBtn');
    var msg = document.getElementById('addLayerMsg');

    function say(text, ok) {
      if (!msg) return;
      msg.textContent = text || '';
      msg.style.color = ok === false ? '#9E2A1C' : '';
    }

    function addRow(layer) {
      var tr = document.createElement('tr');
      tr.dataset.layerId = layer.id;
      tr.innerHTML =
        '<td></td><td></td><td><span class="badge -primary"></span></td>' +
        '<td class="text-muted small"></td>' +
        '<td class="layer-status text-muted small"></td>' +
        '<td class="buttons"><button type="button" class="button -transparent icon icon-delete text-danger layer-delete" title="Remove layer"></button></td>';
      tr.children[0].textContent = layer.title;
      tr.children[1].textContent = layer.kind;
      tr.children[2].querySelector('span').textContent = String(layer.source_format || '').toUpperCase();
      tr.children[3].textContent = layer.file_size ? (layer.file_size / 1048576).toFixed(2) + ' MB' : '';
      rows.appendChild(tr);
      bindDelete(tr);
      refreshStatus(tr, layer);
    }

    function refreshStatus(tr, layer) {
      var cell = tr.querySelector('.layer-status');
      if (!cell) return;
      var conv = layer && layer.conversion;
      if (!conv) { cell.textContent = 'ready'; return; }
      if (conv.status === 'completed') { cell.textContent = 'converted'; return; }
      if (conv.status === 'error') { cell.textContent = 'conversion error: ' + (conv.message || ''); cell.style.color = '#9E2A1C'; return; }
      cell.textContent = 'converting…';
      setTimeout(function () { pollStatus(tr); }, 6000);
    }

    function pollStatus(tr) {
      var id = tr.dataset.layerId;
      if (!id || !document.body.contains(tr)) return;
      fetch(baseUrl + '/' + id + '/file', { credentials: 'same-origin' })
        .then(function (r) {
          var ct = r.headers.get('content-type') || '';
          if (ct.indexOf('json') !== -1) {
            return r.json().then(function (j) { refreshStatus(tr, { conversion: j }); });
          }
          var cell = tr.querySelector('.layer-status');
          if (cell) cell.textContent = 'converted';
        })
        .catch(function () { setTimeout(function () { pollStatus(tr); }, 15000); });
    }

    function bindDelete(tr) {
      var del = tr.querySelector('.layer-delete');
      if (!del) return;
      del.addEventListener('click', function () {
        if (!window.confirm('Remove this layer? The file is deleted from the model.')) return;
        del.disabled = true;
        fetch(baseUrl + '/' + tr.dataset.layerId, {
          method: 'DELETE',
          headers: { 'X-CSRF-Token': csrf },
          credentials: 'same-origin'
        })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (res) {
            if (res && res.success) tr.remove();
            else { del.disabled = false; window.alert('Could not remove the layer.'); }
          })
          .catch(function () { del.disabled = false; });
      });
    }

    Array.prototype.forEach.call(rows.querySelectorAll('tr[data-layer-id]'), function (tr) {
      bindDelete(tr);
      if ((tr.querySelector('.layer-status') || {}).textContent &&
          /pending|processing|converting/i.test(tr.querySelector('.layer-status').textContent)) {
        setTimeout(function () { pollStatus(tr); }, 4000);
      }
    });

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        if (!fd.get('file') || !fd.get('file').name) { say('Choose a file.', false); return; }
        if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
        say('Uploading…', true);

        fetch(createUrl, {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrf },
          credentials: 'same-origin',
          body: fd
        })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (res) {
            if (btn) { btn.disabled = false; btn.textContent = 'Add layer'; }
            if (res && res.success) {
              addRow(res.layer);
              form.reset();
              if (res.warning) {
                say('Layer added, but: ' + res.warning, false);
                window.alert(res.warning);
              } else {
                say('Layer added.', true);
              }
            } else {
              say('Upload failed: ' + ((res && res.errors) || ['unknown error']).join(', '), false);
            }
          })
          .catch(function (err) {
            if (btn) { btn.disabled = false; btn.textContent = 'Add layer'; }
            say('Network error: ' + err, false);
          });
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('turbo:load', init);
  document.addEventListener('turbolinks:load', init);
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(init, 0);
})();
