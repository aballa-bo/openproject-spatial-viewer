  SpatialViewerApp.prototype.initEvents = function() {
    // Bind DOM listeners at most once per #spatialViewerApp node. Without this,
    // a second init on the same node (Turbo re-render race) would attach every
    // handler twice — e.g. the side-panel toggle would fire toggle() twice and
    // appear dead.
    if (this.container.dataset.spatialListeners === '1') return;
    this.container.dataset.spatialListeners = '1';

    var self = this;
    this._resizeHandler = function() {
      var w = self.viewport.clientWidth;
      var h = self.viewport.clientHeight;
      if (w > 0 && h > 0) {
        self.camera.aspect = w / h;
        self.camera.updateProjectionMatrix();
        self.renderer.setSize(w, h);
      }
    };
    window.addEventListener('resize', this._resizeHandler);

    this.viewport.addEventListener('pointerdown', function(e) { self.onPointerDown(e); });
    this.viewport.addEventListener('pointermove', function(e) { self.onPointerMove(e); });
    this.viewport.addEventListener('pointerup', function(e) { self.onPointerUp(e); });
    this.viewport.addEventListener('pointercancel', function(e) { self.onPointerUp(e); });
    // Otherwise a label's/mesh part's red/glow hover state (see
    // _updateHoverEffects) could stay stuck on if the pointer leaves the
    // canvas without ever crossing another hoverable thing on the way out.
    this.viewport.addEventListener('pointerleave', function() { self._clearHoverEffects(); });

    // Zoom toward the point under the cursor (passive:false so we can preventDefault).
    this.viewport.addEventListener('wheel', function(e) { self._onWheel(e); }, { passive: false });

    // WASD + R/F fly navigation. Bound on window so it works as soon as the
    // pointer is over the viewer, but ignored while typing in a field.
    var isTyping = function(t) {
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    this._navKeyDown = function(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      var k = (e.key || '').toLowerCase();
      if ('wasdrf'.indexOf(k) === -1 || k.length !== 1) return;
      self._navKeys[k] = true;
      self._navShift = e.shiftKey;
      e.preventDefault();
    };
    this._navKeyUp = function(e) {
      var k = (e.key || '').toLowerCase();
      if (self._navKeys[k]) delete self._navKeys[k];
      self._navShift = e.shiftKey;
    };
    this._navBlur = function() { self._navKeys = Object.create(null); };
    window.addEventListener('keydown', this._navKeyDown);
    window.addEventListener('keyup', this._navKeyUp);
    window.addEventListener('blur', this._navBlur);
    // NOTE: deliberately no 'lostpointercapture' listener. It bubbles, and
    // OrbitControls captures the pointer on the canvas first; re-capturing
    // would fire it and abort the stroke after a couple of points.
  };

  // ---- Navigation: zoom-to-cursor + WASD/RF fly ------------------------

  // Keep near/far tight around the current viewing distance so you can zoom
  // right up to a surface without it clipping, and keep good depth precision.
  SpatialViewerApp.prototype._updateClip = function(force) {
    if (!this.camera || !this.controls) return;
    var d = this.camera.position.distanceTo(this.controls.target) || 1;
    var r = this.modelRadius || d;
    var near = Math.max(1e-4, Math.min(r / 500, d * 0.02));
    var far = Math.max(d + r * 4, r * 8, 100);
    // Only touch the projection matrix on a meaningful change (avoids per-frame
    // churn while flying with the keys).
    if (force ||
        Math.abs(near - this.camera.near) > near * 0.2 ||
        Math.abs(far - this.camera.far) > far * 0.2) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  };

  // Wheel: dolly toward the world point under the cursor. Both the camera and
  // the orbit target are scaled about that point, so it stays pinned on screen
  // and there is always distance left to cover — no "stuck" zoom.
  SpatialViewerApp.prototype._onWheel = function(e) {
    if (!this.controls || !this.camera) return;
    e.preventDefault();
    if (this.isDrawing) return;

    var rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    var pivot = null;
    var meshes = this._visibleRaycastTargets();
    if (meshes.length) {
      this._ensureBVH(); // keep the per-wheel raycast cheap on big meshes
      var hit = this.raycaster.intersectObjects(meshes, true)[0];
      if (hit) pivot = hit.point.clone();
    }
    if (!pivot) {
      // no surface under the cursor: use the plane through the orbit target
      var n = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.controls.target);
      pivot = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (!pivot) return;
    }

    // deltaMode 1 = lines, 0 = pixels; normalise to roughly one "notch" = 1.
    var notches = e.deltaY / (e.deltaMode === 1 ? 3 : 100);
    var factor = Math.pow(1.18, notches);   // <1 zoom in, >1 zoom out

    var camOff = this.camera.position.clone().sub(pivot);
    var tgtOff = this.controls.target.clone().sub(pivot);
    var r = this.modelRadius || camOff.length() || 10;
    var origLen = camOff.length() || 1e-6;
    var newLen = Math.max(r * 3e-4, Math.min(r * 60, origLen * factor));
    var eff = newLen / origLen;

    this.camera.position.copy(pivot).add(camOff.multiplyScalar(eff));
    this.controls.target.copy(pivot).add(tgtOff.multiplyScalar(eff));
    this.controls.update();
    this._updateClip();
  };

  // Per-frame WASD / R-F movement. Camera and target move together (pan+dolly),
  // so orbiting afterwards still pivots around what you flew to.
  SpatialViewerApp.prototype._processNavKeys = function(dt) {
    var keys = this._navKeys;
    if (!keys) return;
    var kw = keys.w, ks = keys.s, ka = keys.a, kd = keys.d, kr = keys.r, kf = keys.f;
    if (!(kw || ks || ka || kd || kr || kf)) return;
    if (!this.controls || !this.camera) return;
    // Never move the camera mid-stroke: the lasso/draw/measure tools freeze a
    // "selection" camera matrix for their screen-space math on the first
    // sample and only refresh it when the gesture ends — moving the camera
    // while held (e.g. a stray WASD key) desyncs that frozen matrix from the
    // live one and the lasso fill renders offset from what you're drawing.
    if (this.isDrawing) return;

    var n = this._nav;
    this.camera.getWorldDirection(n.fwd).normalize();
    n.right.crossVectors(n.fwd, n.worldUp);
    if (n.right.lengthSq() < 1e-8) n.right.set(1, 0, 0); // looking straight up/down
    n.right.normalize();

    n.move.set(0, 0, 0);
    if (kw) n.move.add(n.fwd);
    if (ks) n.move.sub(n.fwd);
    if (kd) n.move.add(n.right);
    if (ka) n.move.sub(n.right);
    if (kr) n.move.add(n.worldUp);
    if (kf) n.move.sub(n.worldUp);
    if (n.move.lengthSq() < 1e-8) return;

    // Scale by the current viewing distance too, so keys stay usable whether
    // you are far out or nosed up against a wall.
    var d = this.camera.position.distanceTo(this.controls.target) || 1;
    var reach = Math.min(this.modelRadius || 10, d * 1.5) || 10;
    var speed = reach * (this._navShift ? 2.4 : 0.8);
    n.move.normalize().multiplyScalar(speed * dt);

    this.camera.position.add(n.move);
    this.controls.target.add(n.move);
    this._updateClip();
  };

  // Per-frame VR thumbstick locomotion. OrbitControls does nothing in VR (head
  // tracking drives the camera), so without this the player is stuck wherever
  // they stood when the session started. Moves/turns the `xrDolly` rig the
  // camera is parented to, not the camera itself.
  //   left stick  -> move, relative to where the headset is currently facing
  //   right stick X -> snap-turn (comfort default, in 30° steps)
  //   right stick Y -> move up / down
  SpatialViewerApp.prototype._processXRInput = function(dt) {
    var session = this._xrSession;
    if (!session || !session.inputSources || !this.xrDolly || !this.camera) return;

    var DEAD = 0.15;
    var moveX = 0, moveY = 0, turnX = 0, liftY = 0, haveStick = false;

    session.inputSources.forEach(function(src) {
      var gp = src && src.gamepad;
      if (!gp || !gp.axes || gp.axes.length < 2) return;
      // xr-standard mapping puts the thumbstick at axes[2]/[3] when a
      // touchpad also occupies axes[0]/[1]; fall back to [0]/[1] otherwise.
      var ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0];
      var ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1];
      if (Math.abs(ax) < DEAD) ax = 0;
      if (Math.abs(ay) < DEAD) ay = 0;
      if (!ax && !ay) return;
      haveStick = true;

      if (src.handedness === 'right') { turnX = ax; liftY = -ay; }
      else { moveX = ax; moveY = ay; } // 'left', or 'none' on a single-controller setup
    });
    if (!haveStick) return;

    var n = this._nav;

    // Snap-turn: rotate the dolly around the head's current world position so
    // turning feels like turning in place rather than orbiting around it.
    if (Math.abs(turnX) > 0.6) {
      if (!this._xrTurnArmed) {
        this._xrTurnArmed = true;
        var angle = (turnX > 0 ? -1 : 1) * (Math.PI / 6); // 30°
        this.camera.getWorldPosition(n.xrHead);
        this.xrDolly.position.sub(n.xrHead).applyAxisAngle(n.worldUp, angle).add(n.xrHead);
        this.xrDolly.rotateY(angle);
      }
    } else if (Math.abs(turnX) < 0.3) {
      this._xrTurnArmed = false;
    }

    if (moveX || moveY || liftY) {
      this.camera.getWorldDirection(n.fwd);
      n.fwd.y = 0;
      if (n.fwd.lengthSq() < 1e-6) n.fwd.set(0, 0, -1); else n.fwd.normalize();
      n.right.crossVectors(n.fwd, n.worldUp).normalize();

      var speed = (this.modelRadius || 10) * 0.8;
      n.move.set(0, liftY * speed * dt, 0)
        .addScaledVector(n.fwd, -moveY * speed * dt)
        .addScaledVector(n.right, moveX * speed * dt);
      this.xrDolly.position.add(n.move);
    }
  };

  // Build BVH bounds trees for the model meshes (once). Synchronous: a one-time
  // freeze of up to ~1-2 s on very large models, triggered when a tool that
  // needs surface raycasts is first used.
  SpatialViewerApp.prototype._ensureBVH = function() {
    if (this._bvhReady) return;
    installBVH(); // in case the library finished loading after initThree
    if (!THREE.__bvhInstalled) return; // library not ready yet — retry next call
    this._bvhReady = true;
    if (!this.modelMeshObjects) return;

    var todo = this.modelMeshObjects.filter(function(m) {
      if (!m.isMesh || !m.geometry || m.geometry.boundsTree) return false;
      var pos = m.geometry.attributes && m.geometry.attributes.position;
      return pos && pos.count > 30 && pos.count <= 9000000;
    });
    if (!todo.length) return;

    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    todo.forEach(function(m) {
      try { m.geometry.computeBoundsTree({ maxLeafTris: 12 }); } catch (e) {
        console.warn('[SpatialViewer] computeBoundsTree failed:', e);
      }
    });
    var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    console.log('[SpatialViewer] BVH: ' + todo.length + ' tree(s) in ' + Math.round(t1 - t0) + ' ms');
  };

  // Only raycasts against layers that are actually visible right now.
  // THREE.Raycaster.intersectObjects does not check an object's own (or its
  // ancestors') .visible flag -- that's purely a rendering-time concern --
  // so without this, hiding a layer in the panel only stopped it from being
  // drawn, not from being hit: a pin/lasso/measurement click (or, via
  // _onWheel, a scroll-zoom pivot) could silently land on a hidden layer's
  // surface, which is wrong whenever two layers cover different areas of
  // the same scene (common -- e.g. a point cloud and a mesh rarely have
  // identical coverage). Shared by every raycast call site in this file --
  // see _onWheel for the other one; _raycastAt was previously the only one
  // filtered, which is why a wheel-zoom near a hidden layer could still
  // pivot on it even after that fix.
  SpatialViewerApp.prototype._visibleRaycastTargets = function() {
    return (this.modelMeshObjects || []).filter(function(m) {
      var lg = m.userData && m.userData.layerVisibilityGroup;
      return !lg || lg.visible !== false;
    });
  };

  SpatialViewerApp.prototype._raycastAt = function(clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    var intersects = this.raycaster.intersectObjects(this._visibleRaycastTargets(), true);
    if (!intersects.length) return null;

    // Prefer the nearest FRONT-facing hit over the raw nearest one.
    // Real-world scanned/photogrammetric meshes routinely have noisy,
    // near-duplicate or interior geometry (thin double surfaces, stitching
    // artifacts); when the material renders double-sided, a stray
    // back-facing triangle from one of those artifacts can end up slightly
    // closer to the camera than the true outer surface at some pixels but
    // not others. The raw nearest hit then intermittently lands on that
    // artifact instead of the real surface -- a GENUINE ray-mesh
    // intersection, so it looks correct from the exact angle it was picked
    // at, but visibly detached from the surface from any other angle. This
    // doesn't fully fix noisy mesh data (nothing in a raycaster can), but it
    // removes the most common, well-understood cause of it.
    var rayDir = this.raycaster.ray.direction;
    for (var i = 0; i < intersects.length; i++) {
      var hit = intersects[i];
      if (!hit.face) return hit; // no face info (e.g. a Points object) -- nothing to prefer
      var worldNormal = hit.face.normal.clone()
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
      if (worldNormal.dot(rayDir) < 0) return hit; // front-facing: normal points back toward the ray origin
    }
    return intersects[0]; // nothing front-facing (e.g. camera inside the mesh) -- fall back to nearest
  };

  SpatialViewerApp.prototype.getIntersection = function(e) {
    return this._raycastAt(e.clientX, e.clientY);
  };

  // World-space surface normal at a ray hit (identity if unavailable).
  SpatialViewerApp.prototype._hitNormal = function(hit) {
    if (hit.face && hit.face.normal && hit.object) {
      var n = hit.face.normal.clone()
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
      if (n.lengthSq() > 1e-10) return n.normalize();
    }
    return new THREE.Vector3().subVectors(this.camera.position, hit.point).normalize();
  };

  // The hit point, essentially ON the surface (drawn lines use depthTest:false
  // so they never z-fight and need no visible lift).
  SpatialViewerApp.prototype._surfacePoint = function(hit) {
    var off = this.surfaceOffset || 0;
    if (off <= 0) return hit.point.clone();
    return hit.point.clone().addScaledVector(this._hitNormal(hit), off);
  };

  // ---- 2D overlay used to draw the lasso outline -------------------------
  // The lasso is a screen-space gesture: drawing it on a 2D canvas keeps it
  // dense, always closed and exactly under the cursor, with zero raycasting.
  SpatialViewerApp.prototype._ensureLassoOverlay = function() {
    if (this.lassoOverlay && this.lassoOverlay.parentNode) return this.lassoOverlay;
    var c = document.createElement('canvas');
    c.className = 'lasso-overlay';
    c.style.position = 'absolute';
    c.style.left = '0';
    c.style.top = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.pointerEvents = 'none';
    c.style.zIndex = '40';
    this.viewport.appendChild(c);
    this.lassoOverlay = c;
    return c;
  };

  SpatialViewerApp.prototype._drawLassoOverlay = function(path, closed) {
    var c = this._ensureLassoOverlay();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = this.viewport.clientWidth, h = this.viewport.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!path || path.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (var i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    if (closed) ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.activeColor;
    ctx.stroke();
  };

  SpatialViewerApp.prototype._clearLassoOverlay = function() {
    if (!this.lassoOverlay) return;
    var ctx = this.lassoOverlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.lassoOverlay.width, this.lassoOverlay.height);
  };

  SpatialViewerApp.prototype._viewportPoint = function(clientX, clientY) {
    var rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  SpatialViewerApp.prototype.onPointerDown = function(e) {
    // Recorded unconditionally (even in orbit mode, which returns right
    // below) so onPointerUp can tell a plain click on a label card from the
    // end of an orbit drag -- see the label-click check there.
    this._pdownClient = { x: e.clientX, y: e.clientY };
    if (this.currentTool === 'orbit' || e.button !== 0) return;

    var isLasso = this.currentTool === 'lasso';

    // The lasso needs no surface hit to start — it is a screen gesture.
    var hit = isLasso ? null : this.getIntersection(e);
    if (!isLasso && !hit) return;

    if (this.currentTool === 'pin') {
      this.place3DPin(hit.point, this._hitNormal(hit));
      return;
    }
    if (this.currentTool === 'measure') {
      if (!this.measureStartPoint) {
        this.measureStartPoint = hit.point.clone();
        this.showTooltip('Point 1 selected. Click second point to measure.');
      } else {
        this.finishMeasurement(this.measureStartPoint, hit.point);
        this.measureStartPoint = null;
      }
      return;
    }
    if (this.currentTool !== 'draw' && !isLasso) return;

    this.isDrawing = true;
    this.controls.enabled = false;
    this._setLassoHighlight(null);
    // Capture the pointer so the stroke keeps going (and pointerup still fires)
    // even if the cursor leaves the viewport.
    // Capture on the CANVAS — the same element OrbitControls uses — so there is
    // no capture transfer (which would fire lostpointercapture and kill the
    // stroke). Events still bubble to our listeners on the viewport.
    try { if (e.pointerId != null) this.canvas.setPointerCapture(e.pointerId); } catch (ignore) {}
    this._activePointerId = (e.pointerId != null) ? e.pointerId : null;
    this._pointerClient = { x: e.clientX, y: e.clientY };
    this._lastSampleClient = { x: e.clientX, y: e.clientY };

    if (isLasso) {
      this.lassoScreenPath = [this._viewportPoint(e.clientX, e.clientY)];
      this._lassoHlFrame = 0;
      this._drawLassoOverlay(this.lassoScreenPath, true);
    } else {
      this.currentDrawingPoints = [this._surfacePoint(hit)];
      this._updateOutline(this.currentDrawingPoints, false);
    }
  };

  SpatialViewerApp.prototype.onPointerMove = function(e) {
    this._pointerClient = { x: e.clientX, y: e.clientY };
    if (!this.isDrawing) {
      this._updateHoverEffects(e.clientX, e.clientY);
      return;
    }
    this._clearHoverEffects(); // no hover feedback while a drawing tool is actively tracing
    var list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    var n = list.length, cap = 24, stride = n > cap ? Math.ceil(n / cap) : 1;
    for (var i = 0; i < n; i += stride) {
      this._sampleDrawPoint(list[i].clientX, list[i].clientY);
    }
  };

  SpatialViewerApp.prototype._sampleDrawPoint = function(clientX, clientY) {
    if (this.currentTool === 'lasso') return this._sampleLassoScreen(clientX, clientY);
    return this._sampleDrawSurface(clientX, clientY);
  };

  // Lasso: pure screen-space path, interpolated to ~2 px. No raycasting, so it
  // stays dense on any model regardless of triangle count.
  SpatialViewerApp.prototype._sampleLassoScreen = function(clientX, clientY) {
    var path = this.lassoScreenPath;
    if (!path) return;
    if (path.length >= 4000) return;

    var p = this._viewportPoint(clientX, clientY);
    var last = path[path.length - 1];
    var dx = p.x - last.x, dy = p.y - last.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var minPx = 2;
    if (dist < minPx) return;

    var steps = Math.min(Math.floor(dist / minPx), 600);
    for (var s = 1; s <= steps; s++) {
      var t = (s * minPx) / dist;
      path.push({ x: last.x + dx * t, y: last.y + dy * t });
    }
    path.push(p);
    this._lastSampleClient = { x: clientX, y: clientY };

    this._drawLassoOverlay(path, true);
    // Live surface highlight, refreshed every few samples (coarse grid — kept
    // snappy while the pointer is still moving; _finishLasso rebuilds it at
    // full quality once the stroke ends).
    if ((++this._lassoHlFrame % 4) === 0) {
      this._buildLassoFill(path, this.activeColor, false);
    }
  };

  // Free-hand polyline on the surface: still needs a ray per point, but the
  // number of rays per event is capped so a heavy mesh cannot stall the UI.
  SpatialViewerApp.prototype._sampleDrawSurface = function(clientX, clientY) {
    if (this.currentDrawingPoints.length >= 4000) return;
    var minPx = 5;
    var last = this._lastSampleClient;
    if (!last) { this._addSampleRay(clientX, clientY); return; }

    var dx = clientX - last.x, dy = clientY - last.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minPx) return;

    var steps = Math.min(Math.floor(dist / minPx), 8); // hard ray budget
    var added = false;
    for (var s = 1; s <= steps; s++) {
      var t = (s * minPx) / dist;
      if (this._addSampleRay(last.x + dx * t, last.y + dy * t)) added = true;
    }
    if (this._addSampleRay(clientX, clientY)) added = true;
    if (added) this._updateOutline(this.currentDrawingPoints, false);
  };

  SpatialViewerApp.prototype._addSampleRay = function(clientX, clientY) {
    var hit = this._raycastAt(clientX, clientY);
    if (!hit) return false;
    this._lastSampleClient = { x: clientX, y: clientY };
    this.currentDrawingPoints.push(this._surfacePoint(hit));
    return true;
  };

  // Walks up from a hit mesh to the nearest ancestor carrying a glTF node
  // name (GLTFLoader names either the Mesh itself or a wrapping Group,
  // depending on whether the node's primitive got split into child meshes),
  // stopping at the per-layer group (named "layer:<id>" in _harvestLayer) --
  // that name is the layer's own id, not anything element-specific, so it
  // must never be returned as if it were one.
  function ifcElementIdForMesh(obj) {
    for (var o = obj; o; o = o.parent) {
      if (o.name && o.name.indexOf('layer:') === 0) break;
      if (o.name) return o.name;
    }
    return null;
  }

  SpatialViewerApp.prototype.onPointerUp = function(e) {
    // Clicking a lasso's label card (in orbit/navigate mode, i.e. no drawing
    // tool active) opens the same annotation detail view as clicking its
    // entry in the side panel's list -- same behavior, two entry points.
    // Gated on "didn't drag" (a small pixel threshold since the pointer
    // down) so releasing an orbit drag on top of a card doesn't trigger it.
    if (this.currentTool === 'orbit' && e && !this.isDrawing) {
      var moved = this._pdownClient &&
        (Math.abs(e.clientX - this._pdownClient.x) > 5 || Math.abs(e.clientY - this._pdownClient.y) > 5);
      if (!moved) {
        var hitAnnotation = this._raycastAnnotationLabels(e.clientX, e.clientY);
        if (hitAnnotation) { this.openAnnotationDetail(hitAnnotation); return; }

        // Clicking an IFC element directly (same IFC-only gating as the
        // hover glow in _updateHoverEffects) opens a brand new pin
        // annotation on that exact surface point, pre-linked to the
        // element -- instead of requiring the "3D Pin" tool first.
        var ifcHit = this._raycastAt(e.clientX, e.clientY);
        if (ifcHit && ifcHit.object && ifcHit.object.isMesh &&
            ifcHit.object.userData && ifcHit.object.userData.layerKind === 'ifc') {
          this.place3DPin(this._surfacePoint(ifcHit), this._hitNormal(ifcHit), ifcElementIdForMesh(ifcHit.object));
          return;
        }
      }
    }
    if (!this.isDrawing) return;
    this.isDrawing = false;
    // Restore orbiting only if the orbit tool is active — leaving it enabled
    // while a drawing tool is selected let OrbitControls grab the pointer on
    // the next stroke.
    this.controls.enabled = (this.currentTool === 'orbit');
    try {
      if (this._activePointerId != null) this.canvas.releasePointerCapture(this._activePointerId);
    } catch (ignore) {}
    this._activePointerId = null;

    if (this.currentTool === 'lasso') return this._finishLasso();

    var pts = this.currentDrawingPoints || [];
    if (pts.length < 2) { this.clearTempMarkup(); return; }
    this._updateOutline(pts, false);
    this.openAnnotationModal({
      type: 'draw_polyline',
      closed: false,
      points: pts.map(function(p) { return { x: p.x, y: p.y, z: p.z }; })
    });
  };

  SpatialViewerApp.prototype._finishLasso = function() {
    var path = this.lassoScreenPath || [];
    if (path.length < 3) { this._clearLassoOverlay(); this.clearTempMarkup(); return; }

    this._drawLassoOverlay(path, true);
    this._buildLassoFill(path, this.activeColor, true);

    // Now (once) turn a down-sampled screen ring into 3D points for storage.
    // The 2D overlay stays on screen as the outline until the form is closed.
    // 220 matches the polygon resolution _buildLassoFill itself uses
    // (downsamplePolyPx's cap) -- it used to be 64, a leftover from the old
    // GLSL-shader lasso where the ring fed a fixed-size uniform array. That
    // constraint is gone now that the inside-test runs in plain JS, but the
    // low cap stayed, making the *stored* ring a coarser approximation of
    // the drawn shape than the live fill saw. Kept high regardless, since a
    // coarser ring is still used for re-editing and for the fill_grid-based
    // Area computation server-side, even though the on-reload selection
    // highlight (_updateSelectionSpotlight) only needs the ring's centroid
    // and radius and wouldn't itself care about the resolution.
    var ring = this._screenPathToWorldRing(path, 220);
    if (ring.length < 3) { this._clearLassoOverlay(); this.clearTempMarkup(); return; }

    this.currentDrawingPoints = ring;
    console.log('[SpatialViewer] lasso: ' + path.length + ' screen points -> ' + ring.length + ' 3D points');

    // `points` (the ring) is what drives the selection spotlight on reload
    // (see _updateSelectionSpotlight) and stays available for potential
    // re-editing;
    // `fill_*` is the exact triangulated surface patch the user just saw,
    // stored as real 3D points purely for the Area custom field computation
    // server-side (see SpatialAnnotation#calculate_grid_fill_area) -- no
    // longer read by the JS side at all.
    var gd = {
      type: 'lasso_selection',
      closed: true,
      points: ring.map(function(p) { return { x: p.x, y: p.y, z: p.z }; })
    };
    var fg = this._lastLassoGrid;
    if (fg && fg.grid && fg.rows && fg.cols) {
      gd.fill_rows = fg.rows;
      gd.fill_cols = fg.cols;
      gd.fill_grid = fg.grid.map(function(p) {
        return p ? [round5(p.x), round5(p.y), round5(p.z)] : null;
      });
    }

    this.openAnnotationModal(gd);
  };

  // Down-sample the screen ring and project it onto the model; points that miss
  // the mesh fall back to the focal plane so the stored ring always has the
  // shape that was drawn. Uses the same even (float-stride) spacing as
  // downsamplePolyPx -- an earlier integer stride (floor(n/maxPoints)) could
  // stop short of the end of the path whenever maxPoints didn't divide n
  // evenly (e.g. 1000 points at a stride of floor(1000/220)=4 only reaches
  // index 876, silently dropping the last ~12% of the drawn stroke and
  // closing the polygon across the gap instead of the actual shape).
  SpatialViewerApp.prototype._screenPathToWorldRing = function(path, maxPoints) {
    this._ensureBVH();
    var rect = this.canvas.getBoundingClientRect();
    var n = path.length;
    if (n === 0) return [];

    var planeNormal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
    var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      planeNormal, (this.controls ? this.controls.target : new THREE.Vector3()).clone()
    );

    var count = Math.min(maxPoints, n);
    var stride = n / count;
    var pts = new Array(count);
    var planeFallback = new Array(count);
    var anyHit = false;
    for (var i = 0; i < count; i++) {
      var p = path[Math.min(n - 1, Math.floor(i * stride))];
      var hit = this._raycastAt(rect.left + p.x, rect.top + p.y); // also aims this.raycaster.ray at this pixel
      if (hit) { pts[i] = this._surfacePoint(hit); anyHit = true; }
      else { pts[i] = null; planeFallback[i] = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3()); }
    }

    // Sparse point-cloud/splat layers have real gaps between rendered discs --
    // a raycast miss there doesn't mean "off the model" the way it would for a
    // solid mesh. Snapping every miss straight to this camera-facing plane
    // used to land on the right screen pixel from the exact viewpoint the
    // lasso was drawn from, but at the wrong real-world depth -- so
    // reprojecting the saved ring from a different angle/zoom made those
    // stretches of the outline visibly detach from the actual points.
    // Borrowing the nearest successful hit along the path instead keeps every
    // ring vertex glued to real geometry; the plane is now only a last resort,
    // for the (rare) case where literally nothing in the whole stroke hit
    // anything.
    var out = [];
    for (var j = 0; j < count; j++) {
      if (pts[j]) { out.push(pts[j]); continue; }
      if (anyHit) {
        var before = null, after = null;
        for (var b = j - 1; b >= 0; b--) { if (pts[b]) { before = pts[b]; break; } }
        for (var a = j + 1; a < count; a++) { if (pts[a]) { after = pts[a]; break; } }
        if (before || after) out.push((before || after).clone());
      } else if (planeFallback[j]) {
        out.push(planeFallback[j]);
      }
    }
    return out;
  };

  // Outline preview. When closed (lasso) the ring is explicitly closed by
  // repeating the first point (more reliable than LineLoop across drivers).
  SpatialViewerApp.prototype._updateOutline = function(points, closed) {
    if (this.currentDrawingLine) {
      this.tempMarkupGroup.remove(this.currentDrawingLine);
      this.currentDrawingLine.geometry.dispose();
      this.currentDrawingLine = null;
    }
    var pts = (closed && points.length > 2) ? points.concat([points[0]]) : points;
    var geom = new THREE.BufferGeometry().setFromPoints(pts);
    var mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(this.activeColor), depthTest: false, transparent: true
    });
    this.currentDrawingLine = new THREE.Line(geom, mat);
    this.currentDrawingLine.renderOrder = 999;
    this.tempMarkupGroup.add(this.currentDrawingLine);
  };

  SpatialViewerApp.prototype._setLassoHighlight = function(objOrNull) {
    if (!this.lassoHighlightGroup) return;
    var g = this.lassoHighlightGroup;
    while (g.children.length) {
      var c = g.children[0];
      c.traverse(function(n) {
        // geometry is SHARED with the model — never dispose it here
        if (n.geometry && !n.userData._sharedGeometry) n.geometry.dispose();
        if (n.material && n.material.dispose) n.material.dispose();
      });
      g.remove(c);
    }
    this._lassoHl = objOrNull || null;
    if (objOrNull) g.add(objOrNull);
  };

  // Build the lasso fill by casting a grid of rays (one per sample point
  // inside the screen-space polygon) at the model and meshing the hits into a
  // triangle patch -- the live preview shown only while actively drawing a
  // lasso (see _finishLasso and the drag-update call site above).
  // `quality=false` uses a coarser grid for snappy live-drag updates;
  // `_finishLasso` asks for the finer one since it only runs once.
  // `screenPathPx` is in the same canvas-relative CSS-pixel space as
  // `this.lassoScreenPath`.
  SpatialViewerApp.prototype._buildLassoFill = function(screenPathPx, color, quality) {
    this._lastLassoGrid = null; // avoid a stale grid surviving an early return below
    if (!screenPathPx || screenPathPx.length < 3 || !this.modelMeshObjects || !this.modelMeshObjects.length) {
      this._setLassoHighlight(null);
      return;
    }
    this._ensureBVH();

    var rect = this.canvas.getBoundingClientRect();
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < screenPathPx.length; i++) {
      var p = screenPathPx[i];
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    var bboxW = Math.max(1, maxX - minX), bboxH = Math.max(1, maxY - minY);

    var targetSamples = quality ? 2600 : 900;
    var step = Math.sqrt((bboxW * bboxH) / targetSamples);
    step = Math.max(quality ? 3 : 5, Math.min(22, step));

    var cols = Math.min(90, Math.max(2, Math.ceil(bboxW / step) + 1));
    var rows = Math.min(90, Math.max(2, Math.ceil(bboxH / step) + 1));
    var stepX = bboxW / (cols - 1), stepY = bboxH / (rows - 1);
    var poly = downsamplePolyPx(screenPathPx, 220);

    var grid = new Array(cols * rows);
    var any = false;
    for (var gy = 0; gy < rows; gy++) {
      var py = minY + gy * stepY;
      for (var gx = 0; gx < cols; gx++) {
        var px = minX + gx * stepX;
        var idx = gy * cols + gx;
        if (!pointInPolygon(px, py, poly)) { grid[idx] = null; continue; }
        var hit = this._raycastAt(rect.left + px, rect.top + py);
        if (hit) { grid[idx] = hit.point.clone(); any = true; } else { grid[idx] = null; }
      }
    }
    if (!any) { this._setLassoHighlight(null); this._lastLassoGrid = null; return; }

    // Stashed so _finishLasso can persist this exact grid -- kept purely for
    // the Area custom field computation server-side (see
    // SpatialAnnotation#calculate_grid_fill_area); the saved annotation's
    // on-reload highlight is the 3D selection spotlight instead (see
    // _updateSelectionSpotlight), not this grid.
    this._lastLassoGrid = { grid: grid, rows: rows, cols: cols };

    var positions = triangulateLassoGrid(grid, rows, cols);
    if (!positions.length) { this._setLassoHighlight(null); return; }
    this._setLassoHighlight(this._lassoMeshGroup(positions, color));
  };

  // Shared mesh/material construction for a lasso fill patch, given its
  // already-triangulated vertex positions (flat [x,y,z,...] array).
  SpatialViewerApp.prototype._lassoMeshGroup = function(positions, color) {
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.computeVertexNormals();

    var mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthTest: true, depthWrite: false,
      // Every vertex already sits exactly on the real surface — this just
      // nudges the depth comparison so the patch wins the z-fight against it.
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }));
    mesh.renderOrder = 997;
    mesh.frustumCulled = false;

    var group = new THREE.Group();
    group.add(mesh);
    return group;
  };

  // Replaces the old 2D screen-space vignette (projecting the lasso ring to
  // pixels and painting dark bands around it) with a real 3D light: a
  // spotlight from the camera's own position, aimed at the selection, plus
  // dimming the normal scene lights. Three.js places and orients it in
  // world space every frame using the SAME transforms it already uses to
  // render everything else -- there is no separate screen-projection path
  // to drift out of sync with what's actually on screen, which is exactly
  // where the vignette kept getting the position wrong.
  var SELECTION_DIM_FACTOR = 0.22;
  var SELECTION_SPOTLIGHT_COLOR = 0xfff2da;
  var SELECTION_SPOTLIGHT_INTENSITY = 3.2;
  // How far past the selection's own radius (in world units) the spotlight
  // cone reaches -- a multiplier, not a fixed distance, so it scales with
  // the selection's actual real-world size.
  var SELECTION_SPOTLIGHT_CONE_MARGIN = 1.6;
  // Splats/point clouds can't be relit by a THREE.Light at all -- their own
  // dim floor (0.12) is hardcoded directly into the GLSL in
  // SPLAT_VERTEX_SHADER/SPLAT_VERTEX_SHADER_TEX and _buildSplatPoints (see
  // _updateSplatSelectionUniforms), since a JS-side constant here would be
  // concatenated into those shader source strings before this file (which
  // defines it) has even run.

  // Recomputes the selection highlight every frame -- see
  // this.showAnnotationSurface, which sets/clears this._selectedLassoAnnotation,
  // and closeAnnotationDetail, which clears it. Cheap no-op (one flag check)
  // whenever nothing is selected.
  SpatialViewerApp.prototype._updateSelectionSpotlight = function() {
    var a = this._selectedLassoAnnotation;
    var gd = a && a.geometry_data;
    if (!a || !gd || !gd.points || gd.points.length < 3) {
      if (this._selectionLit) this._clearSelectionSpotlight();
      return;
    }

    var camera = this.camera;
    if (!camera) return;

    var ring = gd.points.map(function(p) { return new THREE.Vector3(p.x, p.y, p.z); });
    var centroid = new THREE.Vector3();
    ring.forEach(function(p) { centroid.add(p); });
    centroid.divideScalar(ring.length);
    var radius = 0.05;
    ring.forEach(function(p) { radius = Math.max(radius, p.distanceTo(centroid)); });

    this._selectionLit = true;
    this._applySelectionDim(true);

    var spot = this.selectionSpotlight;
    var camPos = camera.position;
    var distToCam = Math.max(0.1, camPos.distanceTo(centroid));
    spot.position.copy(camPos);
    spot.target.position.copy(centroid);
    spot.target.updateMatrixWorld();
    // Half-angle derived from the selection's real-world radius and the
    // ACTUAL camera distance -- the cone always frames the same real-world
    // area regardless of zoom, rather than a fixed angle that would look
    // right at one distance and wrong at every other.
    spot.angle = Math.min(Math.PI / 2.1, Math.max(0.05, Math.atan2(radius * SELECTION_SPOTLIGHT_CONE_MARGIN, distToCam)));
    spot.distance = distToCam + radius * 6;
    spot.intensity = SELECTION_SPOTLIGHT_INTENSITY;

    this._updateSplatSelectionUniforms(centroid, radius, radius * SELECTION_SPOTLIGHT_CONE_MARGIN, true);
  };

  SpatialViewerApp.prototype._clearSelectionSpotlight = function() {
    this._selectionLit = false;
    if (this.selectionSpotlight) this.selectionSpotlight.intensity = 0;
    this._applySelectionDim(false);
    this._updateSplatSelectionUniforms(null, 0, 1, false);
  };

  // Dims (or restores) the normal scene lights. Reuses _baseLightIntensities
  // (the same per-light formula _applyRenderSettingsUnsafe itself uses) so
  // this always dims relative to whatever the render-settings sliders are
  // currently set to, rather than a remembered value that could go stale if
  // those sliders change while a selection is active.
  SpatialViewerApp.prototype._applySelectionDim = function(active) {
    var base = this._baseLightIntensities();
    var k = active ? SELECTION_DIM_FACTOR : 1;
    if (this.ambientLight) this.ambientLight.intensity = base.ambient * k;
    if (this.keyLight) this.keyLight.intensity = base.key * k;
    if (this.fillLight) this.fillLight.intensity = base.fill * k;
    if (this.hemiLight) this.hemiLight.intensity = base.hemi * k;
  };

  // Pushes the selection's world-space center/radius into every
  // material that can't be relit by a THREE.Light at all (true splats'
  // own ShaderMaterial, and the plain point-cloud fallback's
  // onBeforeCompile-injected uniforms -- see _buildSplatPoints and
  // _buildTrueSplats) so they dim/brighten in step with the real spotlight
  // instead of staying flat regardless of selection.
  SpatialViewerApp.prototype._updateSplatSelectionUniforms = function(center, radius, falloff, active) {
    (this._splatRenderers || []).forEach(function(sr) {
      var u = sr && sr.mesh && sr.mesh.material && sr.mesh.material.uniforms;
      if (!u || !u.uSelCenter) return;
      if (active) u.uSelCenter.value.copy(center);
      u.uSelRadius.value = radius;
      u.uSelFalloff.value = falloff;
      u.uSelActive.value = active ? 1 : 0;
    });
    (this.modelMeshObjects || []).forEach(function(m) {
      var mat = m && m.isPoints && m.material;
      var shader = mat && mat.userData && mat.userData.shader;
      if (!shader || !shader.uniforms || !shader.uniforms.uSelCenter) return;
      if (active) shader.uniforms.uSelCenter.value.copy(center);
      shader.uniforms.uSelRadius.value = radius;
      shader.uniforms.uSelFalloff.value = falloff;
      shader.uniforms.uSelActive.value = active ? 1 : 0;
    });
  };
