
  // ifcElementId (optional): set when this pin was placed by clicking
  // directly on an IFC layer's element (see onPointerUp) rather than via the
  // "3D Pin" drawing tool -- stored in geometry_data so the created
  // annotation stays linked to that specific IFC element (surfaced read-only
  // in the detail panel's "Linked IFC element" field).
  SpatialViewerApp.prototype.place3DPin = function(point, normal, ifcElementId) {
    var g = new THREE.ConeGeometry(0.2, 0.6, 16);
    g.translate(0, 0.3, 0); g.rotateX(Math.PI);
    var mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: new THREE.Color(this.activeColor), roughness: 0.2 }));
    mesh.position.copy(point);
    mesh.quaternion.copy(pinQuaternionFromNormal(normal));
    this.tempMarkupGroup.add(mesh);
    var gd = { type: 'pin', points: [{x:point.x,y:point.y,z:point.z}], normal: {x:normal.x,y:normal.y,z:normal.z} };
    if (ifcElementId) gd.ifc_element_id = ifcElementId;
    this.openAnnotationModal(gd);
  };

  SpatialViewerApp.prototype.finishMeasurement = function(ptA, ptB) {
    var dist = ptA.distanceTo(ptB).toFixed(2);
    var geom = new THREE.BufferGeometry().setFromPoints([ptA, ptB]);
    var mat = new THREE.LineDashedMaterial({ color: 0xf59e0b, dashSize: 0.2, gapSize: 0.1 });
    var line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    this.tempMarkupGroup.add(line);
    this.openAnnotationModal({ type: 'measurement', points: [{x:ptA.x,y:ptA.y,z:ptA.z},{x:ptB.x,y:ptB.y,z:ptB.z}], dist: dist });
  };

  SpatialViewerApp.prototype.captureSnapshot = function() {
    // Every call site adds the new annotation's geometry (pin cone, outline,
    // lasso fill) to the scene and calls this SYNCHRONOUSLY right after, in
    // the same pointerup handler -- before the browser's next vsync, i.e.
    // before setAnimationLoop gets to render a frame that actually contains
    // it. Without forcing a render here first, toDataURL() reads back
    // whatever the PREVIOUS frame already had in the buffer, which is from
    // before this annotation's geometry existed -- the thumbnail then shows
    // the model without the very thing it's supposed to be a preview of.
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
    return this.renderer.domElement.toDataURL('image/png');
  };

  // Opens the inline "New Work Package" panel beside the viewer (BCF-style
  // split view) instead of a modal overlay.
  SpatialViewerApp.prototype.openAnnotationModal = function(gd) {
    this.pendingGeometry = gd;
    this.pendingThumbnail = this.captureSnapshot();
    // Captured HERE (geometry-finalization time), not later in
    // saveAnnotation() -- the create panel stays open (and nothing stops the
    // user switching to the orbit tool to inspect the model) for as long as
    // they're filling in the subject/description/etc. before clicking Save.
    // For a lasso selection specifically, this is what made a save "look
    // aligned while drawing, misaligned once saved": the stored ring is tied
    // to the exact viewpoint it was raycast from, but reading the camera
    // fresh at save time could capture a DIFFERENT viewpoint (if the user
    // had rotated the view in between) -- flying back to that wrong
    // viewpoint on reload and reprojecting the (unrelated) ring through it
    // is pure parallax error. Pin/polyline/measurement annotations have the
    // same gap, just no reprojection step to make it visible.
    this.pendingCameraViewpoint = {
      eye: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
      up: [this.camera.up.x, this.camera.up.y, this.camera.up.z]
    };
    this._detailAnnotation = null; // leave any open detail view

    var panel = document.getElementById('spatialSidePanel');
    var snap = document.getElementById('caSnapshot');
    var subject = document.getElementById('caSubject');
    var descInput = document.getElementById('caDesc');
    var titleEl = document.getElementById('createPanelTitle');

    if (snap) snap.src = this.pendingThumbnail;

    var labels = {
      pin: '3D pin', draw_polyline: 'Mesh drawing',
      lasso_selection: 'Mesh region', measurement: 'Measurement'
    };
    var suggested = gd.type === 'measurement'
      ? ('Measurement: ' + gd.dist + ' m')
      : ((labels[gd.type] || 'Annotation') + ' — ' + (this.projectData && this.projectData.title ? this.projectData.title : '3D model'));

    if (subject) subject.value = suggested;
    if (descInput) descInput.value = '';
    if (titleEl) titleEl.innerText = 'New Work Package';

    // Reset the optional standard fields to their neutral default so a value
    // left over from a previous annotation is not silently reused.
    ['caStatus', 'caPriority', 'caAssignee', 'caAccountable', 'caCategory',
     'caVersion', 'caParent', 'caStartDate', 'caDueDate', 'caEstimatedHours']
      .forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });

    // Reset mode to "new"
    var newRadio = document.querySelector('input[name="caMode"][value="new"]');
    if (newRadio) { newRadio.checked = true; this.updateCreateMode('new'); }

    var typeEl = document.getElementById('caType');
    this._renderCustomFieldsForType(typeEl ? typeEl.value : null);

    this.openSidePanel();
    if (panel) { panel.classList.remove('detailing'); panel.classList.add('creating'); }
    if (subject) subject.focus();
  };

  // ---- Side panel ---------------------------------------------------------
  // State is read back from the DOM on every toggle instead of being kept in an
  // instance flag: a stale flag (e.g. a second viewer instance, or a re-init)
  // would otherwise make every click compute "open -> closed" and the panel
  // could never come back.
  function panelWidthPref() {
    var stored = null;
    try { stored = window.localStorage.getItem('spatialViewer.panelWidth'); } catch (e) {}
    return Math.min(900, Math.max(280, parseInt(stored, 10) || 380));
  }

  function isSidePanelOpen() {
    var sp = document.getElementById('spatialSidePanel');
    if (!sp) return false;
    if (sp.classList.contains('collapsed')) return false;
    var cs = window.getComputedStyle(sp);
    return cs.display !== 'none' && parseFloat(cs.width) > 1;
  }

  function setSidePanelOpen(open, width) {
    var sp = document.getElementById('spatialSidePanel');
    if (!sp) return;
    var app = window.spatialViewerApp;

    if (open) {
      sp.classList.remove('collapsed');
      // Inline styles: no stylesheet rule can keep it hidden.
      sp.style.display = 'flex';
      sp.style.width = (width || panelWidthPref()) + 'px';
      sp.style.minWidth = '';
      // A stale "creating" / "detailing" class would bring the panel back on a
      // sub-view instead of the tabs.
      if (!app || !app.pendingGeometry) sp.classList.remove('creating');
      if (!app || !app._detailAnnotation) sp.classList.remove('detailing');
    } else {
      sp.classList.add('collapsed');
      sp.style.display = 'none';
      sp.style.width = '0px';
    }

    var btn = document.getElementById('btnSidePanelToggle');
    if (btn) {
      if (open) btn.classList.add('active');
      else btn.classList.remove('active');
    }
    if (app) {
      app._panelOpen = open;
      if (app._resizeHandler) app._resizeHandler();
    }
    var cs = window.getComputedStyle(sp);
    console.log('[SpatialViewer] side panel ' + (open ? 'OPEN' : 'CLOSED') +
      ' (display=' + cs.display + ', width=' + cs.width + ')');
  }

  SpatialViewerApp.prototype._initSidePanel = function() {
    var self = this;
    var sp = document.getElementById('spatialSidePanel');
    if (!sp) return;
    this.sidePanel = sp;
    this._panelWidth = panelWidthPref();
    setSidePanelOpen(isSidePanelOpen(), this._panelWidth);

    // Bind once, and deliberately NOT through the app instance: the handler
    // only talks to the DOM, so a stale viewer instance cannot break it.
    var btn = document.getElementById('btnSidePanelToggle');
    if (btn && btn.dataset.spatialToggleBound !== '1') {
      btn.dataset.spatialToggleBound = '1';
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        setSidePanelOpen(!isSidePanelOpen());
      });
    }

    if (!sp.querySelector('.side-panel-resizer')) {
      var grip = document.createElement('div');
      grip.className = 'side-panel-resizer';
      grip.title = 'Drag to resize';
      sp.insertBefore(grip, sp.firstChild);

      var dragging = false, pid = null;
      grip.addEventListener('pointerdown', function(e) {
        dragging = true;
        pid = (e.pointerId != null) ? e.pointerId : null;
        grip.classList.add('dragging');
        try { if (pid != null) grip.setPointerCapture(pid); } catch (ignore) {}
        e.preventDefault();
        e.stopPropagation();
      });
      grip.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        var right = sp.getBoundingClientRect().right;
        self._panelWidth = Math.min(900, Math.max(280, Math.round(right - e.clientX)));
        sp.style.width = self._panelWidth + 'px';
        if (self._resizeHandler) self._resizeHandler();
        e.preventDefault();
      });
      var endDrag = function() {
        if (!dragging) return;
        dragging = false;
        grip.classList.remove('dragging');
        try { if (pid != null) grip.releasePointerCapture(pid); } catch (ignore) {}
        pid = null;
        try { window.localStorage.setItem('spatialViewer.panelWidth', String(self._panelWidth)); } catch (e) {}
      };
      grip.addEventListener('pointerup', endDrag);
      grip.addEventListener('pointercancel', endDrag);
    }
  };

  SpatialViewerApp.prototype._applyPanelState = function() {
    setSidePanelOpen(isSidePanelOpen(), this._panelWidth);
  };

  // Both derive the current state from the DOM, so they can never desynchronise.
  SpatialViewerApp.prototype.toggleSidePanel = function() {
    setSidePanelOpen(!isSidePanelOpen(), this._panelWidth);
  };

  SpatialViewerApp.prototype.openSidePanel = function() {
    if (isSidePanelOpen()) return;
    setSidePanelOpen(true, this._panelWidth);
  };

  SpatialViewerApp.prototype.updateCreateMode = function(mode) {
    var ng = document.getElementById('caNewGroup');
    var eg = document.getElementById('caExistingGroup');
    if (ng) ng.style.display = (mode === 'existing') ? 'none' : 'block';
    if (eg) eg.style.display = (mode === 'existing') ? 'block' : 'none';
  };

  // A field's current value, serialized the same way whether it's freshly
  // rendered, prefilled, or edited by the user -- used both to build a
  // before/after snapshot (see openAnnotationDetail/saveWorkPackageEdits)
  // and, with cfFieldValueForPayload, to collect what actually gets sent.
  function cfFieldValueForSnapshot(field) {
    if (field.dataset.cfFormat === 'bool') return field.checked ? '1' : '0';
    if (field.dataset.cfMulti) {
      return Array.prototype.map.call(field.selectedOptions || [], function(o) { return o.value; }).join('\u0000');
    }
    return field.value;
  }

  // One <input>/<select>/<textarea> per custom field enabled for the given
  // Work Package type (custom fields are enabled per project+type in
  // OpenProject -- see @custom_fields_by_type / this.customFieldsByType).
  // Replaces whatever was previously rendered into `hostId`.
  // data-cf-id/data-cf-format (and data-cf-multi for a multi-value select)
  // are how saveAnnotation/saveWorkPackageEdits collect the values back out
  // generically. `prefill`, when given, is a WP's current
  // `{ custom_field_id: [raw value string, ...] }` (see
  // SpatialAnnotation#work_package_detail_payload) -- used by the "edit
  // linked Work Package" panel, omitted for the "create new" one.
  // Returns a snapshot ({ cfId: serialized value }) of what ended up
  // rendered, for the caller to diff later edits against.
  SpatialViewerApp.prototype._renderCustomFieldsForType = function(typeId, hostId, prefill) {
    var host = document.getElementById(hostId || 'caCustomFields');
    var snapshot = {};
    if (!host) return snapshot;
    host.innerHTML = '';

    var fields = this.customFieldsByType[typeId] || this.customFieldsByType[String(typeId)] || [];
    if (!fields.length) return snapshot;

    var section = document.createElement('p');
    section.className = 'create-panel-section';
    section.textContent = 'Type-specific fields';
    host.appendChild(section);

    fields.forEach(function(cf) {
      var group = document.createElement('div');
      group.className = 'form-group';

      var label = document.createElement('label');
      label.textContent = cf.name + (cf.required ? ' *' : '');
      group.appendChild(label);

      var existing = (prefill && prefill[cf.id]) || [];
      var field;
      if (cf.format === 'text') {
        field = document.createElement('textarea');
        field.className = 'form-textarea';
        field.rows = 3;
        field.value = existing[0] || '';
      } else if (cf.format === 'bool') {
        // Laid out inline with its own label text instead of the shared
        // <label> above (a bare checkbox next to a label reads oddly).
        group.innerHTML = '';
        var boolLabel = document.createElement('label');
        boolLabel.className = 'form-check-label';
        field = document.createElement('input');
        field.type = 'checkbox';
        field.checked = existing[0] === '1' || existing[0] === 't';
        boolLabel.appendChild(field);
        boolLabel.appendChild(document.createTextNode(' ' + cf.name + (cf.required ? ' *' : '')));
        group.appendChild(boolLabel);
      } else if (cf.format === 'list' || cf.format === 'user' || cf.format === 'version') {
        field = document.createElement('select');
        field.className = 'form-select';
        if (cf.multi_value) field.multiple = true;
        if (!cf.required && !cf.multi_value) {
          var blank = document.createElement('option');
          blank.value = '';
          blank.textContent = (cf.format === 'user') ? 'Unassigned' : 'None';
          field.appendChild(blank);
        }
        (cf.options || []).forEach(function(opt) {
          // [label, value] or [label, value, groupLabel] (version: project name).
          var o = document.createElement('option');
          o.value = opt[1];
          o.textContent = opt[0];
          if (existing.indexOf(opt[1]) !== -1) o.selected = true;
          field.appendChild(o);
        });
      } else {
        field = document.createElement('input');
        field.type = (cf.format === 'int' || cf.format === 'float') ? 'number' :
          (cf.format === 'date') ? 'date' : 'text';
        if (cf.format === 'float') field.step = 'any';
        field.className = 'form-input';
        field.value = existing[0] || '';
      }
      field.dataset.cfId = cf.id;
      field.dataset.cfFormat = cf.format;
      if (cf.multi_value) field.dataset.cfMulti = '1';
      group.appendChild(field);

      host.appendChild(group);
      snapshot[cf.id] = cfFieldValueForSnapshot(field);
    });

    return snapshot;
  };

  // Reads back every custom field currently rendered in `hostId` (see
  // _renderCustomFieldsForType), as { cfId: value } ready for the
  // custom_field_values param -- value is a plain string, or an array for a
  // multi-value field. When `snapshot` is given, a field whose current
  // value still matches it is skipped (so an edit only sends what actually
  // changed); omit it to collect everything unconditionally (the "create
  // new work package" panel has no prior state to diff against).
  SpatialViewerApp.prototype._collectCustomFieldValues = function(hostId, snapshot) {
    var out = {};
    document.querySelectorAll('#' + hostId + ' [data-cf-id]').forEach(function(field) {
      var id = field.dataset.cfId;
      if (snapshot && cfFieldValueForSnapshot(field) === (snapshot[id] || '')) return;
      if (field.dataset.cfFormat === 'bool') {
        out[id] = field.checked ? '1' : '0';
      } else if (field.dataset.cfMulti) {
        out[id] = Array.prototype.map.call(field.selectedOptions || [], function(o) { return o.value; });
      } else if (field.value !== '' || snapshot) {
        // Blank with no snapshot (brand new WP): nothing filled in, skip it.
        // Blank where a snapshot existed (editing): the field had a value
        // and the user cleared it -- send the empty string to actually
        // clear it server-side, rather than silently leaving it unchanged.
        out[id] = field.value;
      }
    });
    return out;
  };

  // keepLassoHighlight: true right after a successful save, so the fill the
  // user already saw while drawing (verified correct) is left exactly as is
  // instead of being torn down and rebuilt from the stored ring -- see
  // saveAnnotation.
  SpatialViewerApp.prototype.closeAnnotationForm = function(keepLassoHighlight) {
    var panel = document.getElementById('spatialSidePanel');
    if (panel) panel.classList.remove('creating');
    this.clearTempMarkup();
    this._clearLassoOverlay();
    if (!keepLassoHighlight) this._setLassoHighlight(null);
    this.lassoScreenPath = null;
    this.pendingGeometry = null;
    this.pendingCameraViewpoint = null;
    this._lastLassoGrid = null;
  };

  SpatialViewerApp.prototype.saveAnnotation = function() {
    var self = this;
    var gd = this.pendingGeometry;
    if (!gd) return;

    var mode = (document.querySelector('input[name="caMode"]:checked') || {}).value || 'new';
    var subject = (document.getElementById('caSubject').value || '').trim();
    var desc = document.getElementById('caDesc').value;
    var val = function(id) {
      var el = document.getElementById(id);
      return el && el.value ? el.value : '';
    };
    var existingWpId = val('caExistingWp');

    if (mode === 'existing' && !existingWpId) { alert('Select a Work Package to link.'); return; }
    if (mode === 'new' && !subject) { alert('Enter a subject for the Work Package.'); return; }

    // Every custom field rendered for the currently-selected type -- no
    // prior state to diff against for a brand new work package.
    var customFieldValues = this._collectCustomFieldValues('caCustomFields', null);

    var payload = {
      spatial_annotation: {
        title: (mode === 'new' ? subject : (subject || 'Annotation')),
        description: desc,
        annotation_type: gd.type,
        color: this.activeColor,
        work_package_id: (mode === 'existing') ? existingWpId : null,
        thumbnail_base64: this.pendingThumbnail,
        // Captured back in openAnnotationModal (geometry-finalization time),
        // not read fresh here -- see that function's comment.
        camera_viewpoint: this.pendingCameraViewpoint,
        geometry_data: gd
      },
      create_work_package: (mode === 'new') ? 'true' : 'false',
      wp_subject: subject,
      wp_description: desc,
      wp_type_id: val('caType'),
      wp_status_id: val('caStatus'),
      wp_priority_id: val('caPriority'),
      wp_assigned_to_id: val('caAssignee'),
      wp_responsible_id: val('caAccountable'),
      wp_category_id: val('caCategory'),
      wp_version_id: val('caVersion'),
      wp_parent_id: val('caParent'),
      wp_start_date: val('caStartDate'),
      wp_due_date: val('caDueDate'),
      wp_estimated_hours: val('caEstimatedHours'),
      wp_custom_field_values: customFieldValues
    };

    var saveBtn = document.getElementById('caSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerText = 'Creating…'; }

    fetch(this.apiUrl.replace('/api_data', '/spatial_annotations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(result) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Create'; }
      if (result.success) {
        // For a freshly-created lasso, the fill already on screen is the one
        // the user just saw while drawing -- keep that exact mesh instead of
        // tearing it down and rebuilding it from the stored (re-sampled)
        // ring via showAnnotationSurface, which only needs to run when an
        // OLDER annotation is reopened from a different camera angle.
        var keepLiveFill = gd.type === 'lasso_selection';
        self.closeAnnotationForm(keepLiveFill);
        self.projectData.annotations.unshift(result.annotation);
        self.renderAnnotationsList(self.projectData.annotations);
        self.renderExisting3DAnnotations();
        if (!keepLiveFill) self.showAnnotationSurface(result.annotation);
        // Back to navigate mode once a lasso selection is saved, instead of
        // leaving the lasso tool armed for another draw -- reuses the
        // existing toolOrbit click handler (currentTool/controls.enabled/
        // active class/tooltip) rather than duplicating it here.
        if (gd.type === 'lasso_selection') {
          var orbitBtn = document.getElementById('toolOrbit');
          if (orbitBtn) orbitBtn.click();
        }
        var c = document.getElementById('annotationCountHeader');
        if (c) c.innerText = self.projectData.annotations.length;
        var annTab = document.querySelector('.tab-btn[data-tab="annotationsTab"]');
        if (annTab) annTab.click();
      } else {
        alert('Save error: ' + (result.errors || []).join(', '));
      }
    })
    .catch(function(err) {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Create'; }
      alert('Network error: ' + err);
    });
  };

  // ---- Lasso annotation label cards ---------------------------------------
  // A small always-camera-facing, semi-transparent card shown beside each
  // saved lasso selection (title / linked WP type / description), connected
  // to the selection's ring centroid by a line, colored from the
  // annotation's own color. Built once per renderExisting3DAnnotations call
  // (as a CanvasTexture, the same dependency-free "draw on a 2D canvas,
  // upload as a texture" technique already used for the lasso's screen-space
  // drag overlay); billboard orientation and distance-based scale are then
  // updated every frame in _updateAnnotationLabels, never rebuilt.

  // Greedy word-wrap against actual measured text width (ctx.font must
  // already be set to the font this will be drawn with by the caller -- this
  // sets it too, so a caller can rely on ctx.font being correct afterward).
  // Truncates with an ellipsis if the text doesn't fit in maxLines.
  function wrapCanvasTextLines(ctx, text, font, maxWidth, maxLines) {
    ctx.font = font;
    var words = String(text || '').split(/\s+/).filter(Boolean);
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length && lines.length < maxLines; i++) {
      var word = words[i];
      // A single word wider than the box on its own (long URL, long compound
      // word) can never be split onto a new line -- hard-truncate just that
      // word so it can't overflow the card's edges.
      while (word.length > 1 && ctx.measureText(word).width > maxWidth) word = word.slice(0, -1);
      var test = cur ? cur + ' ' + word : word;
      if (cur && ctx.measureText(test).width > maxWidth) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    var consumedAllWords = lines.join(' ').split(/\s+/).length >= words.length;
    if (!consumedAllWords && lines.length) {
      var last = lines[lines.length - 1];
      while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }

  // Thin rounded-rect outline, drawn manually (not ctx.roundRect, for
  // consistent behavior on every browser this runs on) -- the plain-outline
  // "readout box" shape the HUD reference uses for its callout labels.
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Manual letter-spaced text -- canvas's own ctx.letterSpacing isn't
  // reliably supported everywhere this renders, so characters are placed
  // by hand. Returns the x position just past the last character.
  function fillTextTracked(ctx, text, x, y, spacing) {
    var cx = x;
    for (var i = 0; i < text.length; i++) {
      ctx.fillText(text[i], cx, y);
      cx += ctx.measureText(text[i]).width + spacing;
    }
    return cx - spacing;
  }

  function trackedTextWidth(ctx, text, spacing) {
    var w = 0;
    for (var i = 0; i < text.length; i++) w += ctx.measureText(text[i]).width;
    return w + spacing * Math.max(0, text.length - 1);
  }

  // Truncates (with a trailing ellipsis) so tracked text fits maxWidth --
  // the letter-spaced equivalent of wrapCanvasTextLines's single-line case.
  function truncateTracked(ctx, text, maxWidth, spacing) {
    if (trackedTextWidth(ctx, text, spacing) <= maxWidth) return text;
    var t = text;
    while (t.length > 1 && trackedTextWidth(ctx, t + '…', spacing) > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  function annotationTypeLabel(type) {
    if (type === 'lasso_selection') return 'LASSO SELECTION';
    if (type === 'draw_polyline') return 'POLYLINE';
    if (type === 'pin') return 'PIN';
    if (type === 'measurement') return 'MEASUREMENT';
    return String(type || '').toUpperCase().replace(/_/g, ' ') || 'ANNOTATION';
  }

  // One hand-drawn glyph per SpatialAnnotation::annotation_type (see that
  // model's validation list), stroked/filled in `color` inside the box
  // (bx, by, bsize, bsize). Plain canvas paths rather than the icon font
  // used elsewhere in the UI -- this draws onto an offscreen canvas that
  // becomes a texture, with no guarantee the icon font has finished
  // loading by the time it's rasterized, so a dependency-free vector shape
  // is the only way to render it reliably every time.
  function drawAnnotationTypeIcon(ctx, type, bx, by, bsize, color) {
    var cx = bx + bsize / 2, cy = by + bsize / 2, s = bsize / 2;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.5, bsize * 0.09);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'pin') {
      // Map-pin silhouette: a ringed head over a pointed base.
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.22, s * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.26, cy + s * 0.06);
      ctx.lineTo(cx, cy + s * 0.6);
      ctx.lineTo(cx + s * 0.26, cy + s * 0.06);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.22, s * 0.13, 0, Math.PI * 2);
      ctx.fill();
    } else if (type === 'lasso_selection') {
      // Freeform dashed loop -- a selection outline, not a geometric shape.
      var pts = [
        [-0.36, -0.02], [-0.18, -0.4], [0.24, -0.34], [0.4, 0.02],
        [0.3, 0.38], [-0.08, 0.42], [-0.36, 0.22]
      ];
      ctx.beginPath();
      ctx.moveTo(cx + pts[0][0] * s, cy + pts[0][1] * s);
      for (var i = 1; i <= pts.length; i++) {
        var p0 = pts[i - 1], p1 = pts[i % pts.length];
        var mx = cx + (p0[0] + p1[0]) / 2 * s, my = cy + (p0[1] + p1[1]) / 2 * s;
        ctx.quadraticCurveTo(cx + p0[0] * s, cy + p0[1] * s, mx, my);
      }
      ctx.closePath();
      ctx.setLineDash([bsize * 0.1, bsize * 0.08]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (type === 'draw_polyline') {
      // Zigzag path with its vertices marked -- same idea as the drawn
      // polyline itself, just abstracted to a few points.
      var vtx = [[-0.38, 0.22], [-0.1, -0.32], [0.18, 0.16], [0.4, -0.38]];
      ctx.beginPath();
      ctx.moveTo(cx + vtx[0][0] * s, cy + vtx[0][1] * s);
      for (var j = 1; j < vtx.length; j++) ctx.lineTo(cx + vtx[j][0] * s, cy + vtx[j][1] * s);
      ctx.stroke();
      vtx.forEach(function(p) {
        ctx.beginPath();
        ctx.arc(cx + p[0] * s, cy + p[1] * s, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
      });
    } else if (type === 'measurement') {
      // Ruler: a span between two end ticks, with inward arrowheads.
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.42, cy);
      ctx.lineTo(cx + s * 0.42, cy);
      ctx.stroke();
      [-1, 1].forEach(function(side) {
        var ex = cx + side * s * 0.42;
        ctx.beginPath();
        ctx.moveTo(ex, cy - s * 0.22);
        ctx.lineTo(ex, cy + s * 0.22);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ex, cy - s * 0.14);
        ctx.lineTo(ex - side * s * 0.2, cy);
        ctx.lineTo(ex, cy + s * 0.14);
        ctx.stroke();
      });
    } else {
      // Fallback for any future annotation_type: a plain generic marker.
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Renders the card as a minimal mil-spec/sci-fi HUD "callout": a bare
  // dark readout box (plain thin outline, no chamfering) fed by a small
  // elbowed leader line from a reticle dot, a bold tracked-caps title with
  // a lighter tracked-caps type line beneath it (the HUD reference's
  // bold-keyword / light-descriptor pairing), a divider, then the
  // description below. The annotation's own color is kept, but used
  // sparingly -- just the reticle/leader and a thin left-edge tick --
  // rather than washing the whole card, to match the reference's mostly
  // monochrome white-on-black look.
  function buildAnnotationLabelCanvas(a, colorHex) {
    var W = 512, H = 300, pad = 22, m = 10, topPad = 40;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    var c = new THREE.Color(colorHex);
    var rgb = Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255);
    var accent = 'rgba(' + rgb + ',';

    var x = m, y = topPad, w = W - m * 2, h = H - topPad - m;

    // ---- Leader line: reticle dot outside the box, elbowed into its top edge ----
    var dotX = m + 8, dotY = 14, bendX = x + 40, bendY = y - 16;
    ctx.strokeStyle = accent + '0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(dotX, dotY);
    ctx.lineTo(bendX, bendY);
    ctx.lineTo(bendX, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(dotX, dotY, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = accent + '0.9)';
    ctx.fill();

    // ---- The readout box itself: thin outline, plain near-black fill ----
    roundRectPath(ctx, x, y, w, h, 4);
    ctx.fillStyle = 'rgba(8,10,14,0.74)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.stroke();

    // Thin color-coded tick on the box's left edge -- the one place the
    // annotation's own color still marks the card, for quick visual
    // association with its 3D marker/pin color elsewhere in the viewer.
    ctx.fillStyle = accent + '0.85)';
    ctx.fillRect(x, y + 6, 3, h - 12);

    // ---- Header: small plain-outline icon badge + bold tracked title ----
    var iconSize = 34, iconX = x + pad, iconY = y + pad - 6;
    roundRectPath(ctx, iconX, iconY, iconSize, iconSize, 3);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.stroke();
    drawAnnotationTypeIcon(ctx, a.annotation_type, iconX, iconY, iconSize, 'rgba(255,255,255,0.95)');

    var textX = iconX + iconSize + 14;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 26px monospace';
    var titleY = y + pad + 10;
    fillTextTracked(ctx, truncateTracked(ctx, (a.title || '(untitled)').toUpperCase(), W - pad - textX, 2), textX, titleY, 2);

    // Light tracked-caps descriptor line -- annotation type, plus the
    // linked Work Package type when there is one.
    var typeLine = annotationTypeLabel(a.annotation_type);
    if (a.work_package_type) typeLine += '  ·  ' + String(a.work_package_type).toUpperCase();
    ctx.font = '400 15px monospace';
    ctx.fillStyle = 'rgba(190,198,208,0.95)';
    var typeY = titleY + 22;
    fillTextTracked(ctx, truncateTracked(ctx, typeLine, W - pad - textX, 1.5), textX, typeY, 1.5);

    var headerBottom = Math.max(iconY + iconSize, typeY + 8) + 14;

    // ---- Divider between the title section and the description below ----
    ctx.beginPath();
    ctx.moveTo(x + pad, headerBottom);
    ctx.lineTo(x + w - pad, headerBottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + pad, headerBottom - 4);
    ctx.lineTo(x + pad, headerBottom + 4);
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent + '0.95)';
    ctx.stroke();

    // ---- Description section ----
    if (a.description) {
      var descY = headerBottom + 26;
      var maxDescLines = Math.max(1, Math.floor((y + h - pad - descY) / 23));
      ctx.font = '19px sans-serif';
      var descLines = wrapCanvasTextLines(ctx, a.description, '19px sans-serif', w - pad * 2, maxDescLines);
      ctx.fillStyle = 'rgba(214,221,230,0.9)';
      descLines.forEach(function(line) { ctx.fillText(line, x + pad, descY); descY += 23; });
    }

    return canvas;
  }

  // Soft red glow traced around the callout box's own rounded-rect
  // silhouette, shown only on hover (see _setHoveredLabel) -- not tied to
  // the annotation's own color, since the hover highlight is deliberately
  // always red regardless of the card's base color.
  //
  // Mirrors buildAnnotationLabelCanvas's box geometry (cardW/cardH/m/
  // topPad below must stay in sync with that function's W/H/m/x,y,w,h) so
  // the glow actually hugs the box's shape instead of a generic blob --
  // a plain radial gradient on a square canvas, stretched onto this card's
  // wide/short plane, used to render as an oval with no relation to the
  // box's outline. Drawn on a canvas GLOW_SCALE times bigger (not just a
  // bigger plane) so there's real pixel margin for the blur layers to
  // bleed into without being clipped at the canvas edge; GLOW_SCALE must
  // match the glow plane's own size multiple at its call site in
  // renderExisting3DAnnotations (currently both 1.5), so pixels-per-world-
  // unit stays identical between the glow and card planes and the traced
  // box lines up exactly with the real card's edges once billboarded
  // together.
  function buildAnnotationGlowCanvas() {
    var GLOW_SCALE = 1.5;
    var cardW = 512, cardH = 300, m = 10, topPad = 40;
    var W = cardW * GLOW_SCALE, H = cardH * GLOW_SCALE;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');

    var offX = (W - cardW) / 2, offY = (H - cardH) / 2;
    var x = offX + m, y = offY + topPad, w = cardW - m * 2, h = cardH - topPad - m;

    ctx.lineJoin = 'round';
    // Layered strokes, each wider-blurred and fainter than the last --
    // builds a soft bleed outward from the outline instead of one flat
    // blurred stroke, which looks noticeably more like a glow.
    var layers = [
      { blur: 42, width: 3, alpha: 0.16 },
      { blur: 26, width: 4, alpha: 0.26 },
      { blur: 14, width: 5, alpha: 0.42 },
      { blur: 5, width: 5, alpha: 0.8 }
    ];
    layers.forEach(function(ly) {
      roundRectPath(ctx, x, y, w, h, 4);
      ctx.shadowColor = 'rgba(255,40,40,1)';
      ctx.shadowBlur = ly.blur;
      ctx.lineWidth = ly.width;
      ctx.strokeStyle = 'rgba(255,60,60,' + ly.alpha + ')';
      ctx.stroke();
    });

    // Crisp bright edge right on the silhouette itself, no blur.
    ctx.shadowBlur = 0;
    roundRectPath(ctx, x, y, w, h, 4);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,140,140,0.9)';
    ctx.stroke();

    return canvas;
  }

  // ---- AR: real-world-anchored annotations --------------------------------
  // A model-space anchor point for an annotation -- the pin's own point, or
  // the centroid of a lasso/polyline's stored points. Used as one half of an
  // AR calibration correspondence (see computeArAnchorTransform) -- a
  // separate, AR-specific helper rather than reusing
  // renderExisting3DAnnotations's inline lasso-centroid computation, which
  // is tied to live THREE.Vector3 ring data built during rendering, not the
  // raw a.geometry_data every annotation (including pins) already carries.
  function annotationAnchorPoint(a) {
    var gd = a && a.geometry_data;
    if (!gd || !gd.points || !gd.points.length) return null;
    if (a.annotation_type === 'pin') {
      var p = gd.points[0];
      return new THREE.Vector3(p.x, p.y, p.z);
    }
    var c = new THREE.Vector3();
    gd.points.forEach(function(p) { c.add(new THREE.Vector3(p.x, p.y, p.z)); });
    return c.divideScalar(gd.points.length);
  }

  // The rigid transform (Y-axis rotation + translation, no scale/tilt --
  // see the AR plan for why that's sufficient) mapping model-space points to
  // real-world AR space, from 2 known correspondences. Averages the
  // translation derived from each point pair to split any calibration-tap
  // imprecision evenly between them rather than trusting one arbitrarily.
  function computeArAnchorTransform(m1, m2, r1, r2) {
    var modelAngle = Math.atan2(m2.z - m1.z, m2.x - m1.x);
    var realAngle = Math.atan2(r2.z - r1.z, r2.x - r1.x);
    // THREE.Quaternion.setFromAxisAngle(Y, +angle) rotates +X toward -Z
    // (verified directly against THREE's own rotation, not assumed) -- i.e.
    // a positive angle DECREASES atan2(z,x) heading. To turn the model
    // heading INTO the real heading, the angle is modelAngle - realAngle,
    // not the more "obvious" realAngle - modelAngle (which was tried first
    // and caught by the standalone verification script: every calibration
    // pair came out exactly backwards).
    var q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), modelAngle - realAngle);
    var t1 = r1.clone().sub(m1.clone().applyQuaternion(q));
    var t2 = r2.clone().sub(m2.clone().applyQuaternion(q));
    return { quaternion: q, position: t1.add(t2).multiplyScalar(0.5) };
  }

  // Simple rounded-rect-plus-centered-text button face for the in-AR tool
  // switcher HUD (see _arSetupScene) -- deliberately much plainer than
  // buildAnnotationLabelCanvas above (no title/type/description layout
  // needed, just a short label).
  function buildArHudButtonCanvas(label) {
    var W = 220, H = 90;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var r = 20, x = 4, y = 4, w = W - 8, h = H - 8;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(20,20,26,0.78)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
    ctx.font = 'bold 36px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, W / 2, H / 2 + 2);
    return canvas;
  }

  SpatialViewerApp.prototype.renderExisting3DAnnotations = function() {
    // Dispose the previous build's GPU resources (geometry/material/canvas
    // textures) before discarding them -- plain .remove() leaves them
    // referenced by the renderer's internal WeakMap-keyed state until the
    // object itself is GC'd, and this runs on every save/reload, not just
    // once (see _setLassoHighlight for the same pattern already used for the
    // lasso fill highlight).
    while (this.annotationsGroup.children.length > 0) {
      var oldChild = this.annotationsGroup.children[0];
      oldChild.traverse(function(n) {
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
          if (n.material.map) n.material.map.dispose();
          if (n.material.dispose) n.material.dispose();
        }
      });
      this.annotationsGroup.remove(oldChild);
    }
    this._annotationLabels = [];
    if (!this.projectData || !this.projectData.annotations) return;
    var self = this;
    this.projectData.annotations.forEach(function(a) {
      var col = new THREE.Color(a.color || '#3b82f6');
      var gd = a.geometry_data;
      if (!gd) return;
      if (a.annotation_type === 'pin' && gd.points && gd.points[0]) {
        var pt = gd.points[0];
        var g = new THREE.ConeGeometry(0.25, 0.7, 16);
        g.translate(0, 0.35, 0); g.rotateX(Math.PI);
        var cone = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, roughness: 0.3 }));
        cone.position.set(pt.x, pt.y, pt.z);
        cone.quaternion.copy(pinQuaternionFromNormal(gd.normal));
        cone.userData = { annotation: a };
        self.annotationsGroup.add(cone);
      } else if (a.annotation_type === 'lasso_selection' && gd.points && gd.points.length >= 3) {
        var ring = gd.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
        var loop = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(ring.concat([ring[0]])),
          new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true })
        );
        loop.renderOrder = 998;
        loop.userData = { annotation: a };
        self.annotationsGroup.add(loop);
        // The translucent surface highlight is rebuilt on demand (flyToAnnotation)
        // from the annotation's stored viewpoint — recomputing it for every
        // annotation on load would be too costly on large models.

        // Label card: title/type/description, billboarded every frame by
        // _updateAnnotationLabels (fixed real-world size -- see
        // ANNOTATION_LABEL_WIDTH_M there), connected to the ring's centroid
        // by a line updated the same way.
        var centroid = new THREE.Vector3();
        ring.forEach(function(p) { centroid.add(p); });
        centroid.divideScalar(ring.length);
        var ringRadius = 0;
        ring.forEach(function(p) { ringRadius = Math.max(ringRadius, p.distanceTo(centroid)); });

        var labelCanvas = buildAnnotationLabelCanvas(a, a.color || '#3b82f6');
        var tex = new THREE.CanvasTexture(labelCanvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        var aspect = labelCanvas.width / labelCanvas.height;
        // Geometry is built 1 world unit WIDE at scale 1, so group.scale (set
        // uniformly in _updateAnnotationLabels) directly IS the card's real
        // width in meters -- see ANNOTATION_LABEL_WIDTH_M there.
        var plane = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1 / aspect),
          new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide })
        );
        plane.renderOrder = 1000;

        // Hover-only glow (see _setHoveredLabel) -- a bit larger than the
        // card itself, additively blended, sitting just behind it. Hidden
        // by default; toggled on/off, never rebuilt, as the mouse moves
        // on/off this label.
        var glowPlane = new THREE.Mesh(
          new THREE.PlaneGeometry(1.5, 1.5 / aspect),
          new THREE.MeshBasicMaterial({
            map: new THREE.CanvasTexture(buildAnnotationGlowCanvas()),
            transparent: true, depthTest: false, depthWrite: false,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending
          })
        );
        glowPlane.renderOrder = 999;
        glowPlane.position.z = -0.001;
        glowPlane.visible = false;

        var labelGroup = new THREE.Group();
        labelGroup.add(glowPlane);
        labelGroup.add(plane);
        labelGroup.userData = { annotation: a };
        labelGroup.visible = self._labelsVisible !== false;
        self.annotationsGroup.add(labelGroup);

        var connLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([centroid.clone(), centroid.clone()]),
          new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.85 })
        );
        connLine.renderOrder = 998;
        connLine.userData = { annotation: a };
        connLine.visible = self._labelsVisible !== false;
        self.annotationsGroup.add(connLine);

        self._annotationLabels.push({ group: labelGroup, line: connLine, plane: plane, glow: glowPlane, centroid: centroid, ringRadius: ringRadius, annotation: a });
      } else if (a.annotation_type === 'draw_polyline' && gd.points) {
        var pts = gd.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
        var line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: col, depthTest: false, transparent: true })
        );
        line.renderOrder = 999;
        line.userData = { annotation: a };
        self.annotationsGroup.add(line);
      }
    });
  };

  // Fixed real-world width (meters) of every label card -- it is a physical
  // object placed in the scene, not a screen-space UI overlay, so its
  // on-screen size shrinks with distance purely through normal perspective
  // projection (same as the pin cone's fixed 0.25 radius elsewhere in this
  // file). Deliberately NOT distance-scaled: an earlier version scaled world
  // size up with distance to keep apparent screen size constant, with a
  // floor (MIN_SIZE) to stop text from vanishing -- but that floor meant the
  // card visibly stopped shrinking past a certain distance instead of
  // receding like everything else in the scene, which is what was reported
  // as a bug.
  var ANNOTATION_LABEL_WIDTH_M = 0.6;

  // Billboards every live lasso label card to face the camera and keeps its
  // connecting line anchored to the (fixed) ring centroid and the (moving)
  // label position. Called every frame from the render loop -- cheap even
  // for many annotations, since it only updates existing transforms/
  // attributes, never rebuilds geometry or the canvas texture.
  SpatialViewerApp.prototype._updateAnnotationLabels = function() {
    var labels = this._annotationLabels;
    if (!labels || !labels.length) return;
    var camera = this.camera;
    if (!camera) return;
    var camRight = (this._annLabelTmpRight || (this._annLabelTmpRight = new THREE.Vector3()));
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    var labelPos = (this._annLabelTmpPos || (this._annLabelTmpPos = new THREE.Vector3()));
    var size = ANNOTATION_LABEL_WIDTH_M;
    var offset0 = size * 0.75;
    for (var i = 0; i < labels.length; i++) {
      var L = labels[i];
      labelPos.copy(L.centroid).addScaledVector(camRight, L.ringRadius + offset0);

      L.group.position.copy(labelPos);
      L.group.quaternion.copy(camera.quaternion);
      L.group.scale.set(size, size, size);

      var arr = L.line.geometry.attributes.position.array;
      arr[0] = L.centroid.x; arr[1] = L.centroid.y; arr[2] = L.centroid.z;
      arr[3] = labelPos.x; arr[4] = labelPos.y; arr[5] = labelPos.z;
      L.line.geometry.attributes.position.needsUpdate = true;
    }
  };

  // Hit-tests a click/hover against every live label card's plane (not the
  // model mesh -- see _raycastAt/_visibleRaycastTargets for that, a
  // separate, unrelated target list). Returns the matching entry from
  // _annotationLabels (group/plane/glow/annotation/...), or null.
  SpatialViewerApp.prototype._raycastAnnotationLabelEntry = function(clientX, clientY) {
    var labels = this._annotationLabels;
    if (!labels || !labels.length || this._labelsVisible === false) return null;
    var rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    var planes = labels.map(function(L) { return L.plane; });
    var hits = this.raycaster.intersectObjects(planes, false);
    if (!hits.length) return null;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].plane === hits[0].object) return labels[i];
    }
    return null;
  };

  // Back-compat convenience wrapper for callers that only want the
  // annotation itself (onPointerUp's click-to-open-detail path).
  SpatialViewerApp.prototype._raycastAnnotationLabels = function(clientX, clientY) {
    var L = this._raycastAnnotationLabelEntry(clientX, clientY);
    return L ? L.annotation : null;
  };

  // Red tint + glow while the mouse hovers a lasso annotation's label
  // card (only while labels are toggled on -- see _raycastAnnotationLabelEntry's
  // own _labelsVisible check), OR an IFC layer's mesh part (only while that
  // layer is visible -- _raycastAt already only hits visible layers, see
  // _visibleRaycastTargets). Deliberately does NOT react to photogrammetry/
  // scan mesh layers (layerKind "mesh", set in _harvestLayer): those are one
  // big fused scanned surface with no discrete "parts" an IFC conversion
  // would have, so highlighting "the whole scan" on hover would be
  // meaningless. A label wins over a mesh part directly behind it.
  // Orbit/navigate mode only -- same gating as onPointerUp's click-to-open
  // behavior, so a drawing tool in progress never shows or reacts to this.
  // Called from onPointerMove on every move.
  SpatialViewerApp.prototype._updateHoverEffects = function(clientX, clientY) {
    if (this.currentTool !== 'orbit') { this._clearHoverEffects(); return; }
    var L = this._raycastAnnotationLabelEntry(clientX, clientY);
    this._setHoveredLabel(L);
    var meshHit = null;
    if (!L) {
      var hit = this._raycastAt(clientX, clientY);
      if (hit && hit.object && hit.object.isMesh && hit.object.userData &&
          hit.object.userData.layerKind === 'ifc') {
        meshHit = hit.object;
      }
    }
    this._setHoveredMeshPart(meshHit);
    if (this.viewport) this.viewport.style.cursor = (L || meshHit) ? 'pointer' : '';
  };

  SpatialViewerApp.prototype._clearHoverEffects = function() {
    this._setHoveredLabel(null);
    this._setHoveredMeshPart(null);
    if (this.viewport) this.viewport.style.cursor = '';
  };

  var ANNOTATION_HOVER_COLOR = 0xff3030;

  SpatialViewerApp.prototype._setHoveredLabel = function(L) {
    if (this._hoveredLabel === L) return;
    if (this._hoveredLabel) {
      this._hoveredLabel.plane.material.color.setHex(0xffffff);
      this._hoveredLabel.glow.visible = false;
    }
    this._hoveredLabel = L;
    if (L) {
      L.plane.material.color.setHex(ANNOTATION_HOVER_COLOR);
      L.glow.visible = true;
    }
  };

  // Tinted clone of a model mesh's own material, used ONLY while that mesh
  // is hovered (see _setHoveredMeshPart) -- a clone, never a mutation of
  // the original, because glTF-converted meshes (IFC in particular)
  // routinely share one material instance across many mesh parts, and
  // mutating it in place would turn every part made of that material
  // yellow, not just the one under the cursor.
  function tintMeshMaterialForHover(mat) {
    var c = mat.clone();
    if (c.color) c.color.lerp(new THREE.Color(ANNOTATION_HOVER_COLOR), 0.55);
    if (c.emissive) {
      c.emissive.set(ANNOTATION_HOVER_COLOR);
      if ('emissiveIntensity' in c) c.emissiveIntensity = Math.max(c.emissiveIntensity, 0.6);
    }
    return c;
  }

  // Same red-tint-plus-glow language as the label hover, applied to a
  // model mesh part instead of a billboard card. There is no post-
  // processing bloom pipeline in this viewer, so the "glow" here is the
  // classic cheap stand-in: a slightly bigger, back-face-only, additively
  // blended copy of the same geometry sitting just behind the real surface,
  // bleeding a soft red edge past its silhouette.
  SpatialViewerApp.prototype._setHoveredMeshPart = function(mesh) {
    if (this._hoveredMeshPart === mesh) return;
    if (this._hoveredMeshPart) {
      this._hoveredMeshPart.material = this._hoveredMeshPartOrigMaterial;
      this._hoveredMeshPartOrigMaterial = null;
      (Array.isArray(this._hoveredMeshPartTinted) ? this._hoveredMeshPartTinted : [this._hoveredMeshPartTinted])
        .forEach(function(m) { if (m) m.dispose(); });
      this._hoveredMeshPartTinted = null;
      if (this._meshHoverHalo) {
        if (this._meshHoverHalo.parent) this._meshHoverHalo.parent.remove(this._meshHoverHalo);
        this._meshHoverHalo.material.dispose();
        this._meshHoverHalo = null;
      }
    }
    this._hoveredMeshPart = mesh;
    if (!mesh) return;

    this._hoveredMeshPartOrigMaterial = mesh.material;
    this._hoveredMeshPartTinted = Array.isArray(mesh.material)
      ? mesh.material.map(tintMeshMaterialForHover)
      : tintMeshMaterialForHover(mesh.material);
    mesh.material = this._hoveredMeshPartTinted;

    var halo = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
      color: ANNOTATION_HOVER_COLOR,
      transparent: true,
      opacity: 0.5,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true
    }));
    halo.position.copy(mesh.position);
    halo.quaternion.copy(mesh.quaternion);
    halo.scale.copy(mesh.scale).multiplyScalar(1.03);
    if (mesh.parent) mesh.parent.add(halo);
    this._meshHoverHalo = halo;
  };

  // AR equivalent of _raycastAnnotationLabels, but from an arbitrary 3D ray
  // (an XR input source's pointing ray) instead of a mouse/touch position,
  // and against every clickable annotation mesh in the scene (pin cones AND
  // lasso label-card planes), not just label planes -- in AR there's no
  // separate list like _annotationLabels for pins, so this walks
  // annotationsGroup directly. Returns {annotation, point} or null.
  SpatialViewerApp.prototype._arPickAnnotationAt = function(origin, direction) {
    var targets = [];
    this.annotationsGroup.traverse(function(n) { if (n.isMesh) targets.push(n); });
    this.raycaster.set(origin, direction);
    var hits = this.raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    var obj = hits[0].object;
    var a = (obj.userData && obj.userData.annotation) ||
      (obj.parent && obj.parent.userData && obj.parent.userData.annotation);
    return a ? { annotation: a, point: hits[0].point } : null;
  };

  // Builds (or replaces) the single floating info card shown when an
  // annotation is tapped in AR -- reuses buildAnnotationLabelCanvas as-is
  // (already generic over annotation type, not lasso-specific) and the same
  // CanvasTexture-on-a-plane technique as the desktop lasso label cards.
  // Added directly to the scene in world space (the raycast hit point
  // already IS world space) rather than to arAnchorGroup, so no coordinate
  // conversion is needed.
  SpatialViewerApp.prototype._showArInfoCard = function(a, worldPoint) {
    this._clearArInfoCard();
    var canvas = buildAnnotationLabelCanvas(a, a.color || '#3b82f6');
    var tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    var aspect = canvas.width / canvas.height;
    var plane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4 / aspect),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide })
    );
    plane.renderOrder = 1002;
    var group = new THREE.Group();
    group.add(plane);
    group.position.copy(worldPoint);
    group.position.y += 0.25; // sits just above the tapped point, not on top of it
    this.scene.add(group);
    this._arInfoCard = group;
  };

  SpatialViewerApp.prototype._clearArInfoCard = function() {
    if (!this._arInfoCard) return;
    var card = this._arInfoCard;
    card.traverse(function(n) {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        if (n.material.map) n.material.map.dispose();
        if (n.material.dispose) n.material.dispose();
      }
    });
    if (card.parent) card.parent.remove(card);
    this._arInfoCard = null;
  };

  // Selection highlight for a saved lasso annotation: a real 3D spotlight
  // aimed at its ring, plus dimming the rest of the scene (see
  // _updateSelectionSpotlight), not the solid colored fill shown while
  // actively drawing one -- filling the exact selected area again here read
  // as "this is what's selected" rather than "this is what's highlighted",
  // and competed with the label card for attention. Setting
  // _selectedLassoAnnotation is all this does; the actual light updates
  // happen every frame from the render loop, since the spotlight has to
  // track the camera's current position (see closeAnnotationDetail for
  // where this gets cleared again).
  SpatialViewerApp.prototype.showAnnotationSurface = function(a) {
    this._setLassoHighlight(null);
    this._selectedLassoAnnotation = (a && a.annotation_type === 'lasso_selection') ? a : null;
  };

  SpatialViewerApp.prototype.flyToAnnotation = function(a) {
    var self = this;
    var showSelection = function() { self.showAnnotationSurface(a); };

    if (!a.camera_viewpoint || !a.camera_viewpoint.eye) { showSelection(); return; }

    var startPos = this.camera.position.clone();
    var endPos = new THREE.Vector3(a.camera_viewpoint.eye[0], a.camera_viewpoint.eye[1], a.camera_viewpoint.eye[2]);
    var startTarget = this.controls.target.clone();
    var endTarget = new THREE.Vector3(a.camera_viewpoint.target[0], a.camera_viewpoint.target[1], a.camera_viewpoint.target[2]);
    var progress = 0;
    (function fly() {
      progress += 0.04;
      self.camera.position.lerpVectors(startPos, endPos, progress);
      self.controls.target.lerpVectors(startTarget, endTarget, progress);
      self.controls.update();
      if (progress < 1) requestAnimationFrame(fly);
      else showSelection(); // recompute the surface selection from this viewpoint
    })();
  };

  SpatialViewerApp.prototype.renderAnnotationsList = function(annotations) {
    var list = document.getElementById('annotationsList');
    if (!list) return;
    list.innerHTML = '';
    if (!annotations || annotations.length === 0) {
      list.innerHTML = '<div class="text-muted small text-center p-3">No 3D annotations yet.</div>';
      return;
    }
    // Compact row: snapshot (or a color swatch when there's none) on the
    // left, 3 single-line-truncated rows on the right -- title, then the
    // start of the description, then the type last. Full detail (incl. the
    // linked Work Package, author/date, area) is one click away in
    // openAnnotationDetail, so none of that needs to be repeated here.
    var self = this;
    annotations.forEach(function(a) {
      var card = document.createElement('div');
      card.className = 'ann3d-card';

      var thumb = a.snapshot_url
        ? '<img class="ann3d-thumb" src="' + esc(a.snapshot_url) + '" alt="viewpoint snapshot">'
        : '<div class="ann3d-thumb ann3d-thumb-placeholder" style="background:' + esc(a.color || '#3b82f6') + '"></div>';

      card.innerHTML = thumb +
        '<div class="ann3d-body">' +
          '<div class="ann3d-title">' + esc(a.title || '(untitled)') + '</div>' +
          '<div class="ann3d-desc">' + esc(a.description || '') + '</div>' +
          '<div class="ann3d-type">' + esc(String(a.annotation_type || '').replace(/_/g, ' ').toUpperCase()) + '</div>' +
        '</div>';

      card.addEventListener('click', function() { self.openAnnotationDetail(a); });
      list.appendChild(card);
    });
  };

  // ---- Annotation detail (view + edit annotation / edit linked WP) --------

  SpatialViewerApp.prototype._annUrl = function(id) {
    return this.apiUrl.replace('/api_data', '/spatial_annotations') + (id != null ? '/' + id : '');
  };

  SpatialViewerApp.prototype.openAnnotationDetail = function(a) {
    var self = this;
    this._detailAnnotation = a;
    var $ = function(id) { return document.getElementById(id); };
    var setv = function(id, v) { var el = $(id); if (el) el.value = (v == null ? '' : v); };
    var wp = a.work_package || {};

    var snap = $('adSnapshot');
    if (snap) {
      if (a.snapshot_url) { snap.src = a.snapshot_url; snap.style.display = ''; }
      else { snap.removeAttribute('src'); snap.style.display = 'none'; }
    }
    if ($('adTypeBadge')) {
      $('adTypeBadge').textContent = String(a.annotation_type || '').toUpperCase();
      $('adTypeBadge').style.background = a.color || '#3b82f6';
      $('adTypeBadge').style.color = '#fff';
    }
    if ($('adAuthor')) $('adAuthor').textContent = a.author_name || '';
    if ($('adDate')) $('adDate').textContent = a.created_at || '';

    setv('adTitle', a.title);
    setv('adDesc', a.description);
    var areaGroup = $('adAreaGroup');
    if (areaGroup) {
      var hasArea = a.area != null;
      areaGroup.style.display = hasArea ? '' : 'none';
      if (hasArea) setv('adArea', a.area.toFixed(2) + ' m²');
    }
    var ifcGroup = $('adIfcGroup');
    if (ifcGroup) {
      var ifcElementId = a.geometry_data && a.geometry_data.ifc_element_id;
      ifcGroup.style.display = ifcElementId ? '' : 'none';
      if (ifcElementId) setv('adIfcElement', ifcElementId);
    }
    this._adColor = a.color || '#3b82f6';
    document.querySelectorAll('#adColorGroup .color-dot').forEach(function(d) {
      d.classList.toggle('active', (d.dataset.color || '').toLowerCase() === self._adColor.toLowerCase());
    });

    var hasWp = !!a.work_package_id;
    if ($('adWpFields')) $('adWpFields').style.display = hasWp ? '' : 'none';
    if ($('adWpNum')) $('adWpNum').textContent = hasWp ? ('#' + a.work_package_id) : '(none linked)';
    var openLink = $('adWpOpen');
    if (openLink) {
      openLink.style.display = hasWp ? '' : 'none';
      openLink.href = a.work_package_url || ('/work_packages/' + a.work_package_id);
    }
    this._detailWpFields = {
      adWpSubject: 'subject', adWpDesc: 'description', adWpType: 'type_id',
      adWpStatus: 'status_id', adWpAssignee: 'assigned_to_id', adWpAccountable: 'responsible_id',
      adWpPriority: 'priority_id', adWpCategory: 'category_id', adWpVersion: 'version_id',
      adWpParent: 'parent_id', adWpStartDate: 'start_date', adWpDueDate: 'due_date',
      adWpEstimatedHours: 'estimated_hours'
    };
    if (hasWp) {
      setv('adWpSubject', wp.subject != null ? wp.subject : a.work_package_subject);
      setv('adWpDesc', wp.description);
      setv('adWpType', wp.type_id);
      setv('adWpStatus', wp.status_id);
      setv('adWpAssignee', wp.assigned_to_id);
      setv('adWpAccountable', wp.responsible_id);
      setv('adWpPriority', wp.priority_id);
      setv('adWpCategory', wp.category_id);
      setv('adWpVersion', wp.version_id);
      // The parent may not be in the (capped) options list — add it so the
      // prefill sticks and an unchanged parent is never accidentally cleared.
      var parentSel = $('adWpParent');
      if (parentSel && wp.parent_id && !parentSel.querySelector('option[value="' + wp.parent_id + '"]')) {
        var o = document.createElement('option');
        o.value = wp.parent_id;
        o.textContent = '#' + wp.parent_id;
        parentSel.appendChild(o);
      }
      setv('adWpParent', wp.parent_id);
      setv('adWpStartDate', wp.start_date);
      setv('adWpDueDate', wp.due_date);
      setv('adWpEstimatedHours', wp.estimated_hours);
      // Snapshot the rendered values so we can send only what actually changed.
      this._detailWpSnapshot = {};
      var snapF = this;
      Object.keys(this._detailWpFields).forEach(function(id) {
        var el = document.getElementById(id);
        snapF._detailWpSnapshot[id] = el ? el.value : '';
      });
      // Prefilled from the WP's current values; the returned snapshot is
      // what saveWorkPackageEdits diffs later edits against.
      this._detailWpCustomSnapshot =
        this._renderCustomFieldsForType(wp.type_id, 'adWpCustomFields', wp.custom_field_values);
    }

    var panel = document.getElementById('spatialSidePanel');
    this.openSidePanel();
    if (panel) { panel.classList.remove('creating'); panel.classList.add('detailing'); }
    this.flyToAnnotation(a);
  };

  SpatialViewerApp.prototype.closeAnnotationDetail = function() {
    this._detailAnnotation = null;
    var panel = document.getElementById('spatialSidePanel');
    if (panel) panel.classList.remove('detailing');
    this._setLassoHighlight(null);
    this._selectedLassoAnnotation = null;
    var annTab = document.querySelector('.tab-btn[data-tab="annotationsTab"]');
    if (annTab) annTab.click();
  };

  // Persist the updated annotation into projectData + refresh the views.
  SpatialViewerApp.prototype._applyUpdatedAnnotation = function(updated, keepView) {
    if (!updated || !this.projectData || !this.projectData.annotations) return;
    var list = this.projectData.annotations;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === updated.id) { list[i] = updated; break; }
    }
    this._detailAnnotation = updated;
    this.renderAnnotationsList(list);
    this.renderExisting3DAnnotations();
    // flyToAnnotation (not showAnnotationSurface directly): the selection
    // spotlight tracks the camera every frame regardless (see
    // _updateSelectionSpotlight), but flying back to the annotation's own
    // saved viewpoint is still worth doing here so the user lands back on a
    // familiar view of what they just edited, not wherever they'd
    // orbited/zoomed to while reading the detail panel.
    if (!keepView) this.flyToAnnotation(updated);
  };

  SpatialViewerApp.prototype._sendAnnotation = function(method, payload, btn, onOk) {
    var self = this;
    var a = this._detailAnnotation;
    if (!a) return;
    var label = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = 'Saving…'; }

    fetch(this._annUrl(a.id), {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: payload ? JSON.stringify(payload) : null
    })
      .then(function(r) { return r.json().catch(function() { return {}; }); })
      .then(function(res) {
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
        if (res && res.success) { onOk(res); }
        else { alert('Save failed: ' + ((res && res.errors) || ['unknown error']).join(', ')); }
      })
      .catch(function(err) {
        if (btn) { btn.disabled = false; btn.innerHTML = label; }
        alert('Network error: ' + err);
      });
  };

  SpatialViewerApp.prototype.saveAnnotationEdits = function() {
    var t = (document.getElementById('adTitle').value || '').trim();
    if (!t) { alert('The annotation needs a title.'); return; }
    var payload = {
      spatial_annotation: {
        title: t,
        description: document.getElementById('adDesc').value,
        color: this._adColor || '#3b82f6'
      }
    };
    var self = this;
    this._sendAnnotation('PATCH', payload, document.getElementById('adSaveAnnBtn'), function(res) {
      self._applyUpdatedAnnotation(res.annotation);
      self.showTooltip('Annotation saved.');
    });
  };

  SpatialViewerApp.prototype.saveWorkPackageEdits = function() {
    var a = this._detailAnnotation;
    if (!a || !a.work_package_id) return;
    var fields = this._detailWpFields || {};
    var snap = this._detailWpSnapshot || {};

    var wpPayload = {};
    Object.keys(fields).forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.value !== (snap[id] || '')) wpPayload[fields[id]] = el.value;
    });
    var customFieldValues = this._collectCustomFieldValues('adWpCustomFields', this._detailWpCustomSnapshot || {});
    if (Object.keys(customFieldValues).length) wpPayload.custom_field_values = customFieldValues;
    if (!Object.keys(wpPayload).length) { this.showTooltip('No work package changes to save.'); return; }

    var self = this;
    this._sendAnnotation('PATCH', { work_package: wpPayload }, document.getElementById('adSaveWpBtn'), function(res) {
      self._applyUpdatedAnnotation(res.annotation, true);
      // The fields on screen are now the saved truth — re-baseline both snapshots.
      Object.keys(fields).forEach(function(id) {
        var el = document.getElementById(id);
        self._detailWpSnapshot[id] = el ? el.value : '';
      });
      document.querySelectorAll('#adWpCustomFields [data-cf-id]').forEach(function(field) {
        self._detailWpCustomSnapshot[field.dataset.cfId] = cfFieldValueForSnapshot(field);
      });
      self.showTooltip('Work package saved.');
    });
  };

  SpatialViewerApp.prototype.deleteAnnotationFromDetail = function() {
    var self = this;
    var a = this._detailAnnotation;
    if (!a) return;
    if (!window.confirm('Delete this 3D annotation? The linked Work Package is not deleted.')) return;
    this._sendAnnotation('DELETE', null, document.getElementById('adDeleteBtn'), function() {
      if (self.projectData && self.projectData.annotations) {
        self.projectData.annotations = self.projectData.annotations.filter(function(x) { return x.id !== a.id; });
        var c = document.getElementById('annotationCountHeader');
        if (c) c.textContent = self.projectData.annotations.length;
      }
      self._setLassoHighlight(null);
      self.closeAnnotationDetail();
      self.renderAnnotationsList(self.projectData.annotations);
      self.renderExisting3DAnnotations();
    });
  };

  SpatialViewerApp.prototype._initAnnotationDetail = function() {
    var self = this;
    var bind = function(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('adBackBtn', function() { self.closeAnnotationDetail(); });
    bind('adCloseBtn', function() { self.closeAnnotationDetail(); });
    bind('adSaveAnnBtn', function() { self.saveAnnotationEdits(); });
    bind('adSaveWpBtn', function() { self.saveWorkPackageEdits(); });
    bind('adDeleteBtn', function() { self.deleteAnnotationFromDetail(); });
    var adWpType = document.getElementById('adWpType');
    if (adWpType) {
      adWpType.addEventListener('change', function() {
        // Switching type changes which custom fields are even available (per
        // project+type, see customFieldsByType) -- start that section fresh
        // rather than prefilling with values from the WP's PREVIOUS type.
        self._detailWpCustomSnapshot = self._renderCustomFieldsForType(adWpType.value, 'adWpCustomFields', null);
      });
    }
    document.querySelectorAll('#adColorGroup .color-dot').forEach(function(dot) {
      dot.addEventListener('click', function() {
        document.querySelectorAll('#adColorGroup .color-dot').forEach(function(d) { d.classList.remove('active'); });
        dot.classList.add('active');
        self._adColor = dot.dataset.color;
      });
    });
  };

  SpatialViewerApp.prototype.renderWorkPackagesList = function(wps) {
    var list = document.getElementById('workPackagesList');
    if (!list) return;
    list.innerHTML = '';
    if (!wps || wps.length === 0) {
      list.innerHTML = '<div class="text-muted small text-center p-3">No Work Packages.</div>';
      return;
    }
    wps.forEach(function(wp) {
      var card = document.createElement('a');
      card.className = 'annotation-card';
      card.href = '/work_packages/' + wp.id;
      card.target = '_blank';
      card.rel = 'noopener';
      card.style.display = 'block';
      card.style.textDecoration = 'none';
      card.innerHTML = '<div class="annotation-card-body">' +
        '<div class="annotation-card-header"><span class="annotation-title">#' + wp.id + ' – ' + esc(wp.subject) + '</span>' +
        '<span class="badge -info">' + esc(wp.type || 'Task') + '</span></div>' +
        '<div class="annotation-meta"><span>Status: ' + esc(wp.status || 'New') + '</span><span>Assignee: ' + esc(wp.assigned_to || '-') + '</span></div>' +
        '</div>';
      list.appendChild(card);
    });
  };

