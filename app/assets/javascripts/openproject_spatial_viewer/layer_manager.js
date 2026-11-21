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
      tr.dataset.kind = layer.kind;
      tr.dataset.title = layer.title;
      tr.innerHTML =
        '<td></td><td></td><td><span class="badge -primary"></span></td>' +
        '<td class="text-muted small"></td>' +
        '<td class="layer-status text-muted small"></td>' +
        '<td><input type="checkbox" class="layer-default-visible" checked aria-label="Visible by default"></td>' +
        '<td>' + (layer.kind === 'splat' ? '<select class="layer-selection-layer" aria-label="Selection layer"></select>' : '') + '</td>' +
        '<td>' + (layer.kind === 'pointcloud' ? '<input type="number" class="layer-scale" value="1" min="0.000001" step="any" style="width:6rem" aria-label="Scale">' : '') + '</td>' +
        '<td class="buttons"><button type="button" class="button -transparent icon icon-delete text-danger layer-delete" title="Remove layer"></button></td>';
      tr.children[0].textContent = layer.title;
      tr.children[1].textContent = layer.kind;
      tr.children[2].querySelector('span').textContent = String(layer.source_format || '').toUpperCase();
      tr.children[3].textContent = layer.file_size ? (layer.file_size / 1048576).toFixed(2) + ' MB' : '';
      rows.appendChild(tr);
      bindDelete(tr);
      bindDefaultVisible(tr);
      bindSelectionLayer(tr);
      bindScale(tr);
      refreshSelects();
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

    function bindDefaultVisible(tr) {
      var box = tr.querySelector('.layer-default-visible');
      if (!box) return;
      box.addEventListener('change', function () {
        var want = box.checked;
        box.disabled = true;
        fetch(baseUrl + '/' + tr.dataset.layerId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          credentials: 'same-origin',
          body: JSON.stringify({ spatial_layer: { visible: want } })
        })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (res) {
            box.disabled = false;
            if (!(res && res.success)) { box.checked = !want; window.alert('Could not save the setting.'); }
          })
          .catch(function () { box.disabled = false; box.checked = !want; });
      });
    }

    // Splat rows carry a dropdown of the model's mesh/IFC layers.
    function refreshSelects() {
      var opts = [];
      Array.prototype.forEach.call(rows.querySelectorAll('tr[data-layer-id]'), function (tr) {
        if (tr.dataset.kind === 'mesh' || tr.dataset.kind === 'ifc') {
          opts.push({ id: tr.dataset.layerId, label: tr.dataset.title + ' (' + tr.dataset.kind + ')' });
        }
      });
      Array.prototype.forEach.call(rows.querySelectorAll('.layer-selection-layer'), function (sel) {
        var cur = sel.value || sel.dataset.current || '';
        sel.innerHTML = '';
        var none = document.createElement('option');
        none.value = ''; none.textContent = '\u2014 none \u2014';
        sel.appendChild(none);
        opts.forEach(function (o) {
          var op = document.createElement('option');
          op.value = o.id; op.textContent = o.label;
          sel.appendChild(op);
        });
        sel.value = opts.some(function (o) { return o.id === cur; }) ? cur : '';
        sel.dataset.current = sel.value;
      });
    }

    function bindScale(tr) {
      var inp = tr.querySelector('.layer-scale');
      if (!inp) return;
      inp.dataset.current = inp.value;
      inp.addEventListener('change', function () {
        var v = parseFloat(inp.value), prev = inp.dataset.current;
        if (!(v > 0)) { inp.value = prev; return; }
        inp.disabled = true;
        fetch(baseUrl + '/' + tr.dataset.layerId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          credentials: 'same-origin',
          body: JSON.stringify({ spatial_layer: { scale: v } })
        })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (res) {
            inp.disabled = false;
            if (res && res.success) inp.dataset.current = String(v);
            else { inp.value = prev; window.alert('Could not save the scale.'); }
          })
          .catch(function () { inp.disabled = false; inp.value = prev; });
      });
    }

    function bindSelectionLayer(tr) {
      var sel = tr.querySelector('.layer-selection-layer');
      if (!sel) return;
      sel.addEventListener('change', function () {
        var want = sel.value, prev = sel.dataset.current || '';
        sel.disabled = true;
        fetch(baseUrl + '/' + tr.dataset.layerId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          credentials: 'same-origin',
          body: JSON.stringify({ spatial_layer: { selection_layer_id: want } })
        })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (res) {
            sel.disabled = false;
            if (res && res.success) sel.dataset.current = want;
            else { sel.value = prev; window.alert('Could not save the setting.'); }
          })
          .catch(function () { sel.disabled = false; sel.value = prev; });
      });
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
            if (res && res.success) { tr.remove(); refreshSelects(); }
            else { del.disabled = false; window.alert('Could not remove the layer.'); }
          })
          .catch(function () { del.disabled = false; });
      });
    }

    Array.prototype.forEach.call(rows.querySelectorAll('tr[data-layer-id]'), function (tr) {
      bindDelete(tr);
      bindDefaultVisible(tr);
      bindSelectionLayer(tr);
      bindScale(tr);
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
