
  // ---- IFC structure tree (Project > Site > Building > Storey > elements) --
  // Loaded lazily from the server (xeokit-metadata, the same tool OpenProject's
  // BIM viewer uses) the first time an IFC layer's options are opened. Nodes
  // start collapsed; the checkbox shows/hides a node and everything under it;
  // clicking a name frames it.

  // The scene objects of an IFC layer, by element UUID (IfcConvert names glTF
  // nodes "product-<uuid>-<part>").
  SpatialViewerApp.prototype._ifcObjectsByUuid = function(layerId) {
    var g = this.layerGroups && this.layerGroups[layerId];
    var map = {};
    if (!g) return map;
    var re = /^product-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    var walk = function(o) {
      var mt = o.name && re.exec(o.name);
      if (mt) { (map[mt[1].toLowerCase()] = map[mt[1].toLowerCase()] || []).push(o); return; }
      for (var i = 0; i < o.children.length; i++) walk(o.children[i]);
    };
    walk(g);
    return map;
  };

  SpatialViewerApp.prototype._buildIfcTree = function(layerId, host) {
    var self = this;
    var meta = this.layerMeta[layerId];
    host.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'ifc-tree-title';
    title.textContent = 'Structure';
    host.appendChild(title);
    var body = document.createElement('div');
    body.className = 'ifc-tree';
    body.textContent = 'Loading…';
    host.appendChild(body);

    var url = this.apiUrl.replace('/api_data', '/spatial_layers/' + layerId + '/hierarchy');
    fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
      .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, j: j }; }); })
      .then(function(res) {
        if (!res.ok || !res.j.objects) throw new Error((res.j && res.j.error) || 'unavailable');
        self._renderIfcTree(layerId, body, res.j.objects);
      })
      .catch(function(err) {
        body.textContent = 'Structure not available: ' + (err && err.message || err);
      });
  };

  SpatialViewerApp.prototype._renderIfcTree = function(layerId, body, objects) {
    var self = this;
    var byId = {}, kids = {}, roots = [];
    objects.forEach(function(o) { byId[o.id] = o; kids[o.id] = []; });
    objects.forEach(function(o) {
      if (o.parent && byId[o.parent]) kids[o.parent].push(o); else roots.push(o);
    });
    var objsOf = this._ifcObjectsByUuid(layerId);
    // Hidden elements survive a rebuild of the layer panel.
    this._ifcHidden = this._ifcHidden || {};
    var hidden = this._ifcHidden[layerId] = this._ifcHidden[layerId] || {};

    var descendants = function(o, out) {
      out.push(o);
      kids[o.id].forEach(function(c) { descendants(c, out); });
      return out;
    };
    var count = function(o) { // elements with geometry below (or at) this node
      return descendants(o, []).filter(function(d) { return objsOf[d.id.toLowerCase()]; }).length;
    };
    var applyVisibility = function() {
      Object.keys(objsOf).forEach(function(u) {
        objsOf[u].forEach(function(ob) { ob.visible = !hidden[u]; });
      });
    };
    var nodeBox = function(o) {
      var box = new THREE.Box3();
      descendants(o, []).forEach(function(d) {
        (objsOf[d.id.toLowerCase()] || []).forEach(function(ob) { box.expandByObject(ob); });
      });
      return box;
    };

    var makeNode = function(o, depth) {
      var wrap = document.createElement('div');
      wrap.className = 'ifc-node';
      var row = document.createElement('div');
      row.className = 'ifc-node-row';
      row.style.paddingLeft = (depth * 12) + 'px';

      var children = kids[o.id];
      var tri = document.createElement('button');
      tri.type = 'button';
      tri.className = 'layer-row-toggle ifc-node-toggle';
      var sub = document.createElement('div');
      sub.className = 'ifc-node-children';
      var built = false, open = false;
      var setOpen = function(v) {
        open = v;
        tri.textContent = children.length ? (open ? '▾' : '▸') : '';
        sub.style.display = open ? '' : 'none';
        if (open && !built) {
          built = true;
          children.forEach(function(c) { sub.appendChild(makeNode(c, depth + 1)); });
        }
      };
      tri.addEventListener('click', function() { if (children.length) setOpen(!open); });
      row.appendChild(tri);

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = descendants(o, []).some(function(d) { return !hidden[d.id.toLowerCase()]; });
      cb.title = 'Show / hide';
      cb.addEventListener('change', function() {
        descendants(o, []).forEach(function(d) {
          var u = d.id.toLowerCase();
          if (cb.checked) delete hidden[u]; else hidden[u] = true;
        });
        applyVisibility();
        // reflect the change on already-built descendant checkboxes
        wrap.querySelectorAll('input[type=checkbox]').forEach(function(x) { x.checked = cb.checked; });

      });
      row.appendChild(cb);

      var label = document.createElement('span');
      label.className = 'ifc-node-label';
      var n = count(o);
      var shortType = String(o.type || '').replace(/^Ifc/, '');
      label.textContent = (o.name || shortType || o.id) + (children.length ? ' (' + n + ')' : '');
      label.title = shortType + (o.name ? ' — ' + o.name : '');
      label.addEventListener('click', function() {
        var box = nodeBox(o);
        if (!box.isEmpty()) self._fitKeepDirection(box);
      });
      row.appendChild(label);

      wrap.appendChild(row);
      wrap.appendChild(sub);
      setOpen(false); // collapsed by default
      return wrap;
    };

    body.textContent = '';
    if (!roots.length) { body.textContent = 'No structure in this file.'; return; }
    roots.forEach(function(r) { body.appendChild(makeNode(r, 0)); });
  };
