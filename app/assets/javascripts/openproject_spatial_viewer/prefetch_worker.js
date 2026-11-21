/**
 * Spatial Viewer - layer download worker.
 *
 * Streams layer files off the main thread so downloads keep running while the
 * page is busy parsing / decompressing another layer. Posts progress and, when
 * a file is complete, the Blob (cheap to transfer).
 */
self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type !== 'fetch') return;
  var id = m.id;
  var fail = function (why) { self.postMessage({ type: 'fail', id: id, reason: String(why) }); };

  fetch(m.url, { credentials: 'same-origin' }).then(function (resp) {
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var ct = (resp.headers.get('content-type') || '').toLowerCase();
    var total = parseInt(resp.headers.get('content-length'), 10) || m.size || 0;
    // JSON = conversion envelope or glTF document: leave it to the normal path.
    if (ct.indexOf('/json') !== -1 || !resp.body) throw new Error('not prefetchable');
    self.postMessage({ type: 'start', id: id, total: total });
    var chunks = [], loaded = 0, last = 0, reader = resp.body.getReader();
    var pump = function () {
      return reader.read().then(function (r) {
        if (r.done) return;
        chunks.push(r.value); loaded += r.value.length;
        var now = Date.now();
        if (now - last > 120) { last = now; self.postMessage({ type: 'progress', id: id, loaded: loaded }); }
        return pump();
      });
    };
    return pump().then(function () {
      self.postMessage({ type: 'done', id: id, blob: new Blob(chunks), total: total });
    });
  }).catch(fail);
};
