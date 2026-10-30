  SpatialViewerApp.prototype.initUI = function() {
    if (this.container.dataset.spatialUi === '1') return;
    this.container.dataset.spatialUi = '1';

    var self = this;
    document.querySelectorAll('.tool-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tool-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        self.currentTool = btn.dataset.tool;
        self.controls.enabled = (self.currentTool === 'orbit');
        self.updateTooltip();
        if (self.currentTool !== 'orbit') self._ensureBVH();
      });
    });
    var orbitBtn = document.getElementById('toolOrbit');
    if (orbitBtn) orbitBtn.classList.add('active');

    var viewsBtn = document.getElementById('btnViews');
    var viewsMenu = document.getElementById('viewsDropdownMenu');
    if (viewsBtn && viewsMenu) {
      viewsBtn.addEventListener('click', function() { viewsMenu.classList.toggle('show'); });
      document.addEventListener('click', function(e) { if (!viewsBtn.contains(e.target)) viewsMenu.classList.remove('show'); });
      viewsMenu.querySelectorAll('a').forEach(function(a) {
        a.addEventListener('click', function(e) {
          e.preventDefault();
          var v = a.dataset.view, t = self.controls.target;
          if (v === 'top') self.camera.position.set(t.x, t.y + 20, t.z);
          if (v === 'front') self.camera.position.set(t.x, t.y, t.z + 20);
          if (v === 'right') self.camera.position.set(t.x + 20, t.y, t.z);
          if (v === 'iso') self.camera.position.set(t.x + 15, t.y + 15, t.z + 15);
          self.controls.update();
          viewsMenu.classList.remove('show');
        });
      });
    }

    var navMenuBtn = document.getElementById('btnNavMenu');
    var navMenu = document.getElementById('navDropdownMenu');
    if (navMenuBtn && navMenu) {
      navMenuBtn.addEventListener('click', function(e) { e.stopPropagation(); navMenu.classList.toggle('show'); });
      document.addEventListener('click', function(e) { if (!navMenuBtn.contains(e.target)) navMenu.classList.remove('show'); });
    }
    var setStartBtn = document.getElementById('btnSetStartView');
    if (setStartBtn) setStartBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (navMenu) navMenu.classList.remove('show');
      self._setCurrentViewAsStart();
    });
    var clearStartBtn = document.getElementById('btnClearStartView');
    if (clearStartBtn) clearStartBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if (navMenu) navMenu.classList.remove('show');
      self._clearStartView();
    });

    var clearBtn = document.getElementById('toolClear');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      self.clearTempMarkup();
      self._clearLassoOverlay();
      self._setLassoHighlight(null);
      self.lassoScreenPath = null;
    });

    // Layers/Render/Sections used to be floating panels toggled by their own
    // toolbar buttons -- now plain tabs in the side panel (see
    // show.html.erb), so the generic .tab-btn handler below already covers
    // opening/switching to them; only _buildLayerPanel's own show/hide of
    // its tab button (depending on whether there's more than one layer)
    // remains special-cased, see that method.

    var labelsBtn = document.getElementById('btnAnnotationLabels');
    if (labelsBtn) {
      labelsBtn.classList.toggle('active', this._labelsVisible);
      labelsBtn.addEventListener('click', function() {
        self._labelsVisible = !self._labelsVisible;
        labelsBtn.classList.toggle('active', self._labelsVisible);
        (self._annotationLabels || []).forEach(function(L) {
          L.group.visible = self._labelsVisible;
          L.line.visible = self._labelsVisible;
        });
      });
    }

    this._initRenderPanel();

    var clipX = document.getElementById('clipX'), clipY = document.getElementById('clipY'), clipZ = document.getElementById('clipZ');
    var resetClip = document.getElementById('resetClipBtn');
    if (clipX) clipX.addEventListener('input', function(e) { self.clipPlanes[0].constant = parseFloat(e.target.value); });
    if (clipY) clipY.addEventListener('input', function(e) { self.clipPlanes[1].constant = parseFloat(e.target.value); });
    if (clipZ) clipZ.addEventListener('input', function(e) { self.clipPlanes[2].constant = parseFloat(e.target.value); });
    if (resetClip) resetClip.addEventListener('click', function() {
      self.clipPlanes[0].constant = self.clipPlanes[1].constant = self.clipPlanes[2].constant = 1000;
      if (clipX) clipX.value = 50; if (clipY) clipY.value = 50; if (clipZ) clipZ.value = 50;
    });

    document.querySelectorAll('.tab-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        btn.classList.add('active');
        var tt = document.getElementById(btn.dataset.tab);
        if (tt) tt.classList.add('active');
      });
    });

    this._initSidePanel();
    this._initAnnotationDetail();

    // Inline "New Work Package" create panel
    var caCancel = document.getElementById('caCancelBtn');
    var caCancel2 = document.getElementById('caCancelBtn2');
    var caSave = document.getElementById('caSaveBtn');
    if (caCancel) caCancel.addEventListener('click', function() { self.closeAnnotationForm(); });
    if (caCancel2) caCancel2.addEventListener('click', function() { self.closeAnnotationForm(); });
    if (caSave) caSave.addEventListener('click', function() { self.saveAnnotation(); });

    document.querySelectorAll('input[name="caMode"]').forEach(function(r) {
      r.addEventListener('change', function() { self.updateCreateMode(r.value); });
    });

    var caType = document.getElementById('caType');
    if (caType) caType.addEventListener('change', function() { self._renderCustomFieldsForType(caType.value); });

    document.querySelectorAll('.color-dot').forEach(function(dot) {
      dot.addEventListener('click', function() {
        document.querySelectorAll('.color-dot').forEach(function(d) { d.classList.remove('active'); });
        dot.classList.add('active');
        self.activeColor = dot.dataset.color;
      });
    });

    this.initVR();
    this.initAR();
  };

  // ---- WebXR / VR headsets --------------------------------------------------
  SpatialViewerApp.prototype.initVR = function() {
    var self = this;
    var btn = document.getElementById('btnVR');
    if (!btn) return;

    // WebXR needs a secure context (HTTPS or localhost) and browser support.
    if (!window.isSecureContext || !navigator.xr || !navigator.xr.isSessionSupported) {
      btn.style.display = 'none';
      return;
    }

    btn.disabled = true;
    btn.title = 'Checking VR support...';

    var ENTER_TITLE = 'Enter VR — left stick: move, right stick: turn (snap) / up-down';

    navigator.xr.isSessionSupported('immersive-vr').then(function(supported) {
      if (!supported) { btn.style.display = 'none'; return; }
      btn.style.display = '';
      btn.disabled = false;
      btn.title = ENTER_TITLE;
    }).catch(function() { btn.style.display = 'none'; });

    function endVR() {
      if (self._xrSession) { try { self._xrSession.end(); } catch (ignore) {} }
    }

    function onSessionEnded() {
      if (self._xrSession) self._xrSession.removeEventListener('end', onSessionEnded);
      self._xrSession = null;
      self._xrMode = null;
      self._xrTurnArmed = false;
      self.xrDolly.position.set(0, 0, 0);
      self.xrDolly.rotation.set(0, 0, 0);
      btn.disabled = false;
      btn.classList.remove('active');
      btn.title = ENTER_TITLE;
    }

    btn.addEventListener('click', function() {
      // Only this button's own (VR) session is toggled off by clicking it
      // again -- if an AR session happens to be active instead (see
      // initAR), fall through to requestSession below, which the browser
      // itself rejects (only one immersive session at a time), caught by
      // the existing .catch with a clear message.
      if (self._xrSession && self._xrMode === 'vr') { endVR(); return; }

      btn.disabled = true;

      // A splat scene is by far the most GPU-fill-rate-heavy thing this
      // viewer renders (lots of overlapping alpha-blended quads -- see the
      // sort-cost comments on SplatRenderer/SplatRendererTex above). VR
      // renders that cost TWICE (once per eye), normally at a higher
      // per-eye resolution than the flat canvas and with no foveation, with
      // nothing here previously capping it -- on a weaker/standalone
      // headset GPU that combination can make a single frame take long
      // enough that the browser decides the page is hung and kills/crashes
      // the tab, matching "presses VR, long silence, then crash". Must be
      // set before setSession (three.js requirement), so it's done here,
      // right before requestSession, not after the session exists. Only
      // applied when a splat is actually loaded -- plain OBJ/IFC/point
      // cloud scenes are far cheaper and keep full native resolution.
      try {
        if (self.renderer.xr.setFramebufferScaleFactor) {
          var hasSplats = !!(self._splatRenderers && self._splatRenderers.length);
          self.renderer.xr.setFramebufferScaleFactor(hasSplats ? 0.7 : 1.0);
        }
      } catch (ignore) {}

      // Watchdog: if the session never finishes starting (device/runtime
      // hang rather than an outright rejection), don't leave the button
      // disabled and the page looking frozen forever -- surface it as a
      // recoverable error after a timeout instead. This can't abort a
      // native hang already in progress, but it stops OUR UI from being
      // stuck once/if control does return to JS.
      var settled = false;
      var watchdog = setTimeout(function() {
        if (settled) return;
        settled = true;
        console.error('[SpatialViewer] VR session did not start within 20s -- giving up.');
        if (self._xrSession) { try { self._xrSession.end(); } catch (ignore) {} }
        self._xrSession = null;
        self._xrMode = null;
        btn.disabled = false;
        btn.classList.remove('active');
        btn.title = ENTER_TITLE;
        alert('VR is taking too long to start and may be stuck -- try reloading the page, or restarting the headset\'s browser.');
      }, 20000);

      navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
      }).then(function(session) {
        self._xrSession = session;
        self._xrMode = 'vr';
        session.addEventListener('end', onSessionEnded);

        // Stand the player ~1.6 m below and 3 m back from the current focus
        // point so the model is in front of them on entry.
        var t = self.controls ? self.controls.target : new THREE.Vector3();
        self.xrDolly.position.set(t.x, t.y - 1.6, t.z + 3);
        self.xrDolly.rotation.set(0, 0, 0);
        self._xrTurnArmed = false;

        try { self.renderer.xr.setReferenceSpaceType('local-floor'); } catch (ignore) {}
        return self.renderer.xr.setSession(session).then(function() {
          if (settled) return; // watchdog already fired and tore this down
          settled = true;
          clearTimeout(watchdog);
          btn.disabled = false;
          btn.classList.add('active');
          btn.title = 'Exit VR';
        });
      }).catch(function(err) {
        if (settled) return; // watchdog already handled it
        settled = true;
        clearTimeout(watchdog);
        console.error('[SpatialViewer] Could not start VR session:', err);
        if (self._xrSession) { try { self._xrSession.end(); } catch (ignore) {} }
        self._xrSession = null;
        self._xrMode = null;
        self.xrDolly.position.set(0, 0, 0);
        self.xrDolly.rotation.set(0, 0, 0);
        btn.disabled = false;
        btn.classList.remove('active');
        btn.title = ENTER_TITLE;
        alert('Could not start VR: ' + (err.message || err));
      });
    });
  };

  // ---- WebXR / AR passthrough (additive -- does not touch VR above) ------
  // Unlike VR (a self-contained virtual room), AR overlays the real,
  // physical site -- so only the annotations are shown (never the mesh/
  // point cloud/splat model itself), and they must appear in the correct
  // real-world position. That requires a one-time per-session calibration:
  // the user picks 2 existing annotations they can physically walk up to,
  // then in AR taps each one's real-world location (via a hit-test
  // reticle) to establish how model space maps onto the real, tracked AR
  // space -- see computeArAnchorTransform above for the math.
  SpatialViewerApp.prototype.initAR = function() {
    var self = this;
    var btn = document.getElementById('btnAR');
    if (!btn) return;

    if (!window.isSecureContext || !navigator.xr || !navigator.xr.isSessionSupported) {
      btn.style.display = 'none';
      return;
    }

    btn.disabled = true;
    navigator.xr.isSessionSupported('immersive-ar').then(function(supported) {
      if (!supported) { btn.style.display = 'none'; return; }
      btn.style.display = '';
      btn.disabled = false;
    }).catch(function() { btn.style.display = 'none'; });

    var calibPanel = document.getElementById('arCalibPanel');
    var ref1Sel = document.getElementById('arCalibRef1');
    var ref2Sel = document.getElementById('arCalibRef2');
    var statusEl = document.getElementById('arCalibStatus');
    var startBtn = document.getElementById('arCalibStartBtn');
    var closeBtn = document.getElementById('closeArCalibBtn');
    if (!calibPanel || !ref1Sel || !ref2Sel || !startBtn) return;

    function populateRefSelects() {
      var opts = (self.projectData && self.projectData.annotations || []).filter(function(a) {
        return !!annotationAnchorPoint(a);
      });
      [ref1Sel, ref2Sel].forEach(function(sel) {
        sel.innerHTML = '';
        opts.forEach(function(a) {
          var o = document.createElement('option');
          o.value = String(a.id);
          o.textContent = a.title || ('#' + a.id);
          sel.appendChild(o);
        });
      });
      if (opts.length > 1 && ref2Sel.options.length > 1) ref2Sel.selectedIndex = 1;
    }

    function endAR() {
      if (self._xrSession) { try { self._xrSession.end(); } catch (ignore) {} }
    }

    function onARSessionEnded() {
      if (self._xrSession) self._xrSession.removeEventListener('end', onARSessionEnded);
      self._xrSession = null;
      self._xrMode = null;
      self._arTeardownScene();
      btn.disabled = false;
      btn.classList.remove('active');
    }

    function onARSelect(event) { self._handleArSelect(event); }
    function onARSelectStart(event) { self._handleArSelectStart(event); }
    function onARSelectEnd(event) { self._handleArSelectEnd(event); }

    function startARSession() {
      btn.disabled = true;
      navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test', 'local-floor'] })
        .then(function(session) {
          self._xrSession = session;
          self._xrMode = 'ar';
          session.addEventListener('end', onARSessionEnded);
          session.addEventListener('select', onARSelect);
          // selectstart/selectend bound a lasso-drawing stroke -- see
          // _handleArSelectStart/_handleArSelectEnd. 'select' alone (a
          // completed tap) is enough for calibration taps, HUD taps, and
          // placing a pin.
          session.addEventListener('selectstart', onARSelectStart);
          session.addEventListener('selectend', onARSelectEnd);

          self._arSetupScene();

          session.requestReferenceSpace('viewer').then(function(viewerSpace) {
            return session.requestHitTestSource({ space: viewerSpace });
          }).then(function(source) {
            self._arHitTestSource = source;
          }).catch(function(err) {
            console.warn('[SpatialViewer] AR hit-test source unavailable:', err);
          });

          try { self.renderer.xr.setReferenceSpaceType('local-floor'); } catch (ignore) {}
          return self.renderer.xr.setSession(session).then(function() {
            btn.disabled = false;
            btn.classList.add('active');
            self._updateArCalibStatus();
          });
        }).catch(function(err) {
          console.error('[SpatialViewer] Could not start AR session:', err);
          self._xrSession = null;
          self._xrMode = null;
          btn.disabled = false;
          btn.classList.remove('active');
          alert('Could not start AR: ' + (err.message || err));
        });
    }

    btn.addEventListener('click', function() {
      if (self._xrSession && self._xrMode === 'ar') { endAR(); return; }
      populateRefSelects();
      if (statusEl) statusEl.textContent = '';
      calibPanel.style.display = 'block';
    });

    if (closeBtn) closeBtn.addEventListener('click', function() { calibPanel.style.display = 'none'; });

    startBtn.addEventListener('click', function() {
      var annotations = (self.projectData && self.projectData.annotations) || [];
      var a1 = annotations.find(function(a) { return String(a.id) === ref1Sel.value; });
      var a2 = annotations.find(function(a) { return String(a.id) === ref2Sel.value; });
      if (!a1 || !a2 || a1.id === a2.id) { alert('Pick two different reference points.'); return; }
      var p1 = annotationAnchorPoint(a1), p2 = annotationAnchorPoint(a2);
      if (!p1 || !p2) { alert('Could not read those annotations’ positions.'); return; }
      self._arCalibModelPoints = [p1, p2];
      self._arCalibRealPoints = [];
      self._arCalibStep = 0;
      calibPanel.style.display = 'none';
      startARSession();
    });
  };

  // Hides the real model, reparents annotationsGroup under a fresh
  // arAnchorGroup (its transform is set once calibration finishes --
  // identity until then), and builds the hit-test reticle. Mirrors initVR's
  // own entry setup, but AR's scene changes are undone on session end
  // (_arTeardownScene) rather than persisting, since nothing here should
  // affect the normal desktop/VR view afterward.
  SpatialViewerApp.prototype._arSetupScene = function() {
    var self = this;
    this._arHiddenGroups = [];
    Object.keys(this.layerGroups || {}).forEach(function(id) {
      var g = self.layerGroups[id];
      if (g && g.visible) { self._arHiddenGroups.push(g); g.visible = false; }
    });
    [this.gridHelper, this.shadowCatcher, this.lassoHighlightGroup, this.tempMarkupGroup].forEach(function(g) {
      if (g && g.visible) { self._arHiddenGroups.push(g); g.visible = false; }
    });

    this.arAnchorGroup = new THREE.Group();
    this.scene.add(this.arAnchorGroup);
    this._arAnnotationsOriginalParent = this.annotationsGroup.parent;
    this.arAnchorGroup.add(this.annotationsGroup);

    this._arReticle = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide })
    );
    this._arReticle.visible = false;
    this._arReticle.renderOrder = 1001;
    this.scene.add(this._arReticle);

    // Tool switcher HUD -- 3 small always-visible buttons attached to the
    // camera (so they follow the headset/phone), used once calibration is
    // done to pick between inspecting existing annotations (default) and
    // creating a new pin or lasso region. Same canvas-texture-on-a-plane
    // technique as every other label in this file.
    this._arHud = new THREE.Group();
    this._arHud.position.set(0, -0.2, -0.5);
    this.camera.add(this._arHud);
    [
      { tool: 'inspect', label: 'Inspect', x: -0.17 },
      { tool: 'pin', label: 'Pin', x: 0 },
      { tool: 'lasso', label: 'Lasso', x: 0.17 }
    ].forEach(function(t) {
      var canvas = buildArHudButtonCanvas(t.label);
      var tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      var aspect = canvas.width / canvas.height;
      var h = 0.05;
      var mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(h * aspect, h),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide,
          opacity: t.tool === 'inspect' ? 1.0 : 0.55
        })
      );
      mesh.position.set(t.x, 0, 0);
      mesh.renderOrder = 1003;
      mesh.userData = { arTool: t.tool };
      self._arHud.add(mesh);
    });

    this._arTool = 'inspect';
    this._arLassoActive = false;
    this._arLassoPoints = null;
    this._arLassoLastPoint = null;
    this._arLastFrame = null;
    this._arHitTestSource = null;
  };

  SpatialViewerApp.prototype._arTeardownScene = function() {
    (this._arHiddenGroups || []).forEach(function(g) { g.visible = true; });
    this._arHiddenGroups = null;

    if (this._arAnnotationsOriginalParent) this._arAnnotationsOriginalParent.add(this.annotationsGroup);
    this._arAnnotationsOriginalParent = null;

    if (this.arAnchorGroup) { this.scene.remove(this.arAnchorGroup); this.arAnchorGroup = null; }
    if (this._arReticle) {
      this._arReticle.geometry.dispose();
      this._arReticle.material.dispose();
      this.scene.remove(this._arReticle);
      this._arReticle = null;
    }
    this._clearArInfoCard();
    if (this._arHud) {
      this._arHud.traverse(function(n) {
        if (n.geometry) n.geometry.dispose();
        if (n.material) {
          if (n.material.map) n.material.map.dispose();
          if (n.material.dispose) n.material.dispose();
        }
      });
      if (this._arHud.parent) this._arHud.parent.remove(this._arHud);
      this._arHud = null;
    }
    if (this._arHitTestSource) { try { this._arHitTestSource.cancel(); } catch (ignore) {} this._arHitTestSource = null; }
    this._arLastFrame = null;
    this._arCalibStep = 0;
    this._arCalibModelPoints = null;
    this._arCalibRealPoints = null;
    this._arTool = null;
    this._arLassoActive = false;
    this._arLassoPoints = null;
    this._arLassoLastPoint = null;
  };

  // Called every presenting-AR frame from the main render loop (see
  // initThree). The reticle stays live for the whole session now, not just
  // during calibration -- placing a pin and sampling a lasso stroke both
  // read its current position every frame, same as calibration did.
  SpatialViewerApp.prototype._processARFrame = function(frame) {
    if (this._arInfoCard) this._arInfoCard.quaternion.copy(this.camera.quaternion);
    this._arUpdateReticle(frame);
    if (this._arLassoActive) this._arSampleLassoPoint();
  };

  SpatialViewerApp.prototype._arUpdateReticle = function(frame) {
    if (!this._arReticle) return;
    if (!frame || !this._arHitTestSource) { this._arReticle.visible = false; return; }
    var refSpace = this.renderer.xr.getReferenceSpace();
    if (!refSpace) { this._arReticle.visible = false; return; }
    var results = frame.getHitTestResults(this._arHitTestSource);
    if (results.length) {
      var pose = results[0].getPose(refSpace);
      if (pose) {
        this._arReticle.visible = true;
        this._arReticle.matrix.fromArray(pose.transform.matrix);
        this._arReticle.matrix.decompose(this._arReticle.position, this._arReticle.quaternion, this._arReticle.scale);
        return;
      }
    }
    this._arReticle.visible = false;
  };

  SpatialViewerApp.prototype._updateArCalibStatus = function() {
    var el = document.getElementById('arCalibStatus');
    if (!el) return;
    var msgs = [
      'Point at the FIRST reference point’s real-world location and tap/select to confirm.',
      'Now point at the SECOND reference point’s real-world location and tap/select to confirm.'
    ];
    el.textContent = msgs[this._arCalibStep] || '';
  };

  SpatialViewerApp.prototype._finishArCalibration = function() {
    var xform = computeArAnchorTransform(
      this._arCalibModelPoints[0], this._arCalibModelPoints[1],
      this._arCalibRealPoints[0], this._arCalibRealPoints[1]
    );
    this.arAnchorGroup.quaternion.copy(xform.quaternion);
    this.arAnchorGroup.position.copy(xform.position);
    // The reticle keeps running after this (not hidden) -- placing a pin
    // and sampling a lasso stroke both need it live for the rest of the
    // session, see _processARFrame/_arUpdateReticle.
    this._updateArCalibStatus();
  };

  // Routes a WebXR 'select' event (screen tap on handheld AR, or a
  // controller trigger) to either a calibration-point confirmation (the
  // first 2 taps) or an annotation pick (every tap after that) -- see
  // initAR's session setup for how this gets attached.
  SpatialViewerApp.prototype._handleArSelect = function(event) {
    if (this._arCalibStep < 2) {
      if (!this._arReticle || !this._arReticle.visible) return; // no valid surface under the ray yet
      this._arCalibRealPoints[this._arCalibStep] = this._arReticle.position.clone();
      this._arCalibStep++;
      if (this._arCalibStep >= 2) this._finishArCalibration();
      else this._updateArCalibStatus();
      return;
    }

    var ray = this._arRayFromEvent(event);
    if (!ray) return;

    // The HUD tool switcher takes priority over every other tap.
    var hudTool = this._arPickHudTool(ray.origin, ray.direction);
    if (hudTool) { this._setArTool(hudTool); return; }

    if (this._arTool === 'pin') { this._arPlacePinAtReticle(); return; }
    if (this._arTool === 'lasso') return; // driven by selectstart/selectend below, not a single select

    var pick = this._arPickAnnotationAt(ray.origin, ray.direction);
    if (pick) this._showArInfoCard(pick.annotation, pick.point);
    else this._clearArInfoCard();
  };

  // Shared ray extraction for every 'select'-family handler: the XR input
  // source's pointing ray (screen tap on handheld AR, or a controller), as
  // a world-space origin/direction pair ready for this.raycaster.
  SpatialViewerApp.prototype._arRayFromEvent = function(event) {
    var frame = this._arLastFrame;
    var refSpace = this.renderer.xr.getReferenceSpace();
    if (!frame || !refSpace || !event.inputSource || !event.inputSource.targetRaySpace) return null;
    var pose = frame.getPose(event.inputSource.targetRaySpace, refSpace);
    if (!pose) return null;
    var m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    return {
      origin: new THREE.Vector3().setFromMatrixPosition(m),
      direction: new THREE.Vector3(0, 0, -1).transformDirection(m)
    };
  };

  // Hit-tests the 3 HUD tool buttons (see _arSetupScene) and returns the
  // tapped tool name, or null if the ray missed all of them.
  SpatialViewerApp.prototype._arPickHudTool = function(origin, direction) {
    if (!this._arHud) return null;
    var buttons = this._arHud.children.filter(function(c) { return c.isMesh; });
    this.raycaster.set(origin, direction);
    var hits = this.raycaster.intersectObjects(buttons, false);
    return hits.length ? hits[0].object.userData.arTool : null;
  };

  SpatialViewerApp.prototype._setArTool = function(tool) {
    this._arTool = tool;
    // Any in-progress lasso stroke is abandoned when switching tools mid-hold
    // (selectstart already fired under the old tool) -- selectend will see
    // too few points and simply not create anything.
    this._arLassoActive = false;
    if (this._arHud) {
      this._arHud.children.forEach(function(btn) {
        if (btn.userData && btn.userData.arTool) {
          btn.material.opacity = (btn.userData.arTool === tool) ? 1.0 : 0.55;
        }
      });
    }
  };

  // Converts the current reticle hit (a real surface point AND its normal)
  // into model space and creates a pin there. The normal needs the
  // calibration ROTATION only (not worldToLocal, which also subtracts
  // position -- correct for a point, wrong for a direction).
  SpatialViewerApp.prototype._arPlacePinAtReticle = function() {
    if (!this._arReticle || !this._arReticle.visible || !this.arAnchorGroup) return;
    var modelPos = this.arAnchorGroup.worldToLocal(this._arReticle.position.clone());
    var worldNormal = new THREE.Vector3(0, 1, 0).applyQuaternion(this._arReticle.quaternion);
    var invRot = this.arAnchorGroup.quaternion.clone().invert();
    var modelNormal = worldNormal.applyQuaternion(invRot).normalize();
    this._createArAnnotation({
      type: 'pin',
      points: [{ x: modelPos.x, y: modelPos.y, z: modelPos.z }],
      normal: { x: modelNormal.x, y: modelNormal.y, z: modelNormal.z }
    });
  };

  // selectstart/selectend bound a lasso stroke: begin collecting hit-test
  // points (sampled every frame in _processARFrame while active) on
  // selectstart, close the loop and create the annotation on selectend.
  // Calibration taps only ever go through the plain 'select' handler above,
  // so both bail out immediately if calibration isn't finished yet.
  SpatialViewerApp.prototype._handleArSelectStart = function(event) {
    if (this._arCalibStep < 2) return;
    var ray = this._arRayFromEvent(event);
    if (ray && this._arPickHudTool(ray.origin, ray.direction)) return; // a HUD tap, not a stroke
    if (this._arTool !== 'lasso') return;
    this._arLassoActive = true;
    this._arLassoPoints = [];
    this._arLassoLastPoint = null;
  };

  SpatialViewerApp.prototype._handleArSelectEnd = function() {
    if (!this._arLassoActive) return;
    this._arLassoActive = false;
    var pts = this._arLassoPoints || [];
    if (pts.length < 3) return;
    this._createArAnnotation({
      type: 'lasso_selection',
      closed: true,
      points: pts.map(function(p) { return { x: p.x, y: p.y, z: p.z }; })
    });
  };

  // Called every AR frame (from _processARFrame) while a lasso stroke is
  // active. Mirrors the desktop lasso's own minimum-spacing dedup
  // (_sampleLassoScreen's `minPx` check) but in real-world meters instead
  // of screen pixels, since there's no 2D path here -- just a sequence of
  // real-world hit-test points converted straight to model space.
  SpatialViewerApp.prototype._arSampleLassoPoint = function() {
    if (!this._arReticle || !this._arReticle.visible || !this.arAnchorGroup) return;
    var modelPoint = this.arAnchorGroup.worldToLocal(this._arReticle.position.clone());
    var last = this._arLassoLastPoint;
    if (last && last.distanceTo(modelPoint) < 0.05) return; // 5cm minimum spacing
    this._arLassoPoints.push(modelPoint);
    this._arLassoLastPoint = modelPoint;
  };

  // POSTs a newly AR-created annotation (pin or lasso) with an automatic
  // title and no linked Work Package or snapshot -- there's no in-AR
  // keyboard to fill those in, so the user completes them afterward via the
  // normal detail panel, same as any other field. Mirrors saveAnnotation's
  // own fetch/payload shape (this._annUrl(), same headers) but with
  // create_work_package left to its own server-side defaults (falls back to
  // this title and the project's default type -- see
  // SpatialAnnotationsController#create_work_package, unchanged).
  SpatialViewerApp.prototype._createArAnnotation = function(gd) {
    var self = this;
    var title = (gd.type === 'pin' ? 'AR pin — ' : 'AR region — ') + new Date().toLocaleString();
    var payload = {
      spatial_annotation: {
        title: title,
        description: '',
        annotation_type: gd.type,
        color: this.activeColor || '#3b82f6',
        work_package_id: null,
        thumbnail_base64: null,
        camera_viewpoint: null,
        geometry_data: gd
      },
      create_work_package: 'true',
      wp_subject: title,
      wp_description: ''
    };
    fetch(this._annUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrfToken },
      body: JSON.stringify(payload)
    })
      .then(function(r) { return r.json(); })
      .then(function(result) {
        if (result && result.success) {
          self.projectData.annotations.unshift(result.annotation);
          self.renderAnnotationsList(self.projectData.annotations);
          self.renderExisting3DAnnotations();
          self._flashArConfirm();
          // Same reasoning as the desktop save flow: once a lasso region is
          // saved, drop back to inspect mode instead of leaving 'lasso'
          // armed for another stroke.
          if (gd.type === 'lasso_selection') self._setArTool('inspect');
        } else {
          console.warn('[SpatialViewer] AR annotation create failed:', result && result.errors);
        }
      })
      .catch(function(err) {
        console.warn('[SpatialViewer] AR annotation create network error:', err);
      });
  };

  // Brief visual acknowledgement that a pin/lasso was created -- there's no
  // toast/alert visible during an immersive session, so this is the only
  // feedback available: flash the reticle white for 200ms.
  SpatialViewerApp.prototype._flashArConfirm = function() {
    if (!this._arReticle) return;
    var mat = this._arReticle.material;
    var original = mat.color.getHex();
    mat.color.setHex(0xffffff);
    setTimeout(function() {
      try { mat.color.setHex(original); } catch (ignore) {}
    }, 200);
  };

  SpatialViewerApp.prototype.updateTooltip = function() {
    var tip = document.getElementById('drawingTooltip');
    if (!tip) return;
    var msgs = { pin: 'Click on the surface to place a 3D pin.', draw: 'Click and drag along the surface to draw a polyline.', lasso: 'Drag around a region — the outline closes as you draw and the model surface inside it is highlighted.', measure: 'Click first point then second point to measure.' };
    if (msgs[this.currentTool]) { tip.innerText = msgs[this.currentTool]; tip.style.display = 'block'; }
    else { tip.style.display = 'none'; }
  };

  SpatialViewerApp.prototype.showTooltip = function(text) {
    var tip = document.getElementById('drawingTooltip');
    if (tip) { tip.innerHTML = text; tip.style.display = 'block'; }
  };

  SpatialViewerApp.prototype.clearTempMarkup = function() {
    while (this.tempMarkupGroup.children.length > 0) {
      var c = this.tempMarkupGroup.children[0];
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material.dispose) c.material.dispose();
      this.tempMarkupGroup.remove(c);
    }
    this.currentDrawingLine = null;
    this.currentDrawingPoints = [];
  };

  // Back-compat alias
  SpatialViewerApp.prototype.closeModal = function() {
    this.closeAnnotationForm();
  };

  SpatialViewerApp.prototype.showLoader = function(text) {
    var l = document.getElementById('viewerLoader'), t = document.getElementById('loaderText');
    if (t) t.innerText = text;
    if (l) l.style.display = 'flex';
  };

  SpatialViewerApp.prototype.hideLoader = function() {
    var l = document.getElementById('viewerLoader');
    if (l) l.style.display = 'none';
  };
