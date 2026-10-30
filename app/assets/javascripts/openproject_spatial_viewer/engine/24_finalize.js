  // ---- Post-load finalization -------------------------------------------
  // Runs once any parser above (21/22/23) has produced a THREE.Object3D:
  // guards against non-finite geometry, adds it to the scene, and the demo
  // model shown when nothing else loaded.

  };

  // Some exporters (and some corrupt downloads) leave NaN/Infinity in vertex
  // positions. three then reports "computed radius is NaN" and the whole model
  // vanishes. Collapse any triangle that touches a non-finite vertex so the
  // rest of the mesh still renders.
  SpatialViewerApp.prototype._sanitizeModelGeometry = function() {
    var fixed = 0;
    (this.modelMeshObjects || []).forEach(function(m) {
      var g = m.geometry;
      var pos = g && g.attributes && g.attributes.position;
      if (!pos || !pos.array) return;
      var arr = pos.array;
      var meshFixed = 0;

      if (g.index && g.index.array) {
        var idx = g.index.array;
        for (var t = 0; t + 2 < idx.length; t += 3) {
          var bad = false;
          for (var k = 0; k < 3 && !bad; k++) {
            var vi = idx[t + k] * 3;
            if (!isFinite(arr[vi]) || !isFinite(arr[vi + 1]) || !isFinite(arr[vi + 2])) bad = true;
          }
          if (bad) { idx[t + 1] = idx[t]; idx[t + 2] = idx[t]; meshFixed++; }
        }
        if (meshFixed) g.index.needsUpdate = true;
      } else {
        for (var i = 0; i + 8 < arr.length; i += 9) {
          var nan = false;
          for (var j = 0; j < 9 && !nan; j++) if (!isFinite(arr[i + j])) nan = true;
          if (nan) { for (var j2 = 0; j2 < 9; j2++) arr[i + j2] = 0; meshFixed++; }
        }
        if (meshFixed) pos.needsUpdate = true;
      }

      if (meshFixed) {
        g.boundingBox = null;
        g.boundingSphere = null;
        fixed += meshFixed;
      }
    });
    return fixed;
  };

  SpatialViewerApp.prototype.onModelLoaded = function(object) {
    var layerId = this._loadingLayerId;
    var layered = (layerId != null);

    this.modelObject = object;
    this.scene.add(object);

    this._bvhReady = false; // rebuild BVH for the new geometry on next tool use
    this._setLassoHighlight(null); // any old highlight references the old geometry
    // During this call modelMeshObjects holds only this layer's meshes (so
    // sanitize / BVH / bbox scope to it); _harvestLayer then merges the set.
    var thisLayerMeshes = [];
    this.modelMeshObjects = thisLayerMeshes;
    this._lastLayerMeshes = thisLayerMeshes;
    var self = this;
    var heavy = !!this.heavyMode;
    var triangles = 0;

    object.traverse(function(child) {
      if (child.isMesh || child.isPoints) {
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(function(m) { m.clippingPlanes = self.clipPlanes; });
          } else {
            child.material.clippingPlanes = self.clipPlanes;
          }
        }
        thisLayerMeshes.push(child);

        var g = child.geometry;
        if (g && g.index) triangles += g.index.count / 3;
        else if (g && g.attributes && g.attributes.position) triangles += g.attributes.position.count / 3;
      }
    });

    // Reject NaN / non-finite vertex data before it poisons the camera, the
    // bounding box and the BVH (symptom: "computed radius is NaN", blank view).
    var cleaned = this._sanitizeModelGeometry();
    if (cleaned) console.warn('[SpatialViewer] removed ' + cleaned + ' non-finite vertices from the model');

    // (1) Escalate to heavy mode if the mesh is dense even when the file is small.
    if (!heavy && triangles > 4000000) {
      heavy = this.heavyMode = true;
    }
    this._applyPerformanceMode();
    this._modelBlob = null; // release the downloaded bytes

    // Build the BVH now for light models (cheap); defer it for heavy ones to
    // the first time a drawing tool is used.
    if (!heavy) this._ensureBVH();

    var box = new THREE.Box3().setFromObject(object);
    var center = box.getCenter(new THREE.Vector3());
    var size = box.getSize(new THREE.Vector3());
    var maxDim = Math.max(size.x, size.y, size.z);
    if (!isFinite(maxDim) || maxDim <= 0) {
      console.error('[SpatialViewer] model bounding box is not finite — falling back to a default view');
      box = new THREE.Box3(new THREE.Vector3(-10, -10, -10), new THREE.Vector3(10, 10, 10));
      center = new THREE.Vector3();
      maxDim = 20;
    }

    // Frame the camera on the FIRST layer only — later layers are already in
    // the same coordinate system, so we keep the user's current viewpoint.
    if (!this._framed) {
      this._framed = true;
      this.modelRadius = maxDim;
      this.surfaceOffset = 0;
      if (this.raycaster) this.raycaster.params.Points.threshold = maxDim * 0.01;

      // Open on the saved "start view" (camera position + orbit target) when
      // the model has one, otherwise auto fit-to-view as before.
      var startView = this.projectData && this.projectData.settings && this.projectData.settings.start_view;
      if (startView && startView.position && startView.target) {
        this.controls.target.set(startView.target.x, startView.target.y, startView.target.z);
        this.camera.position.set(startView.position.x, startView.position.y, startView.position.z);
      } else {
        this.controls.target.copy(center);
        this.camera.position.set(center.x + maxDim * 1.5, center.y + maxDim * 1.2, center.z + maxDim * 1.5);
      }
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this._updateClip(true);

      try {
        this._fitShadowsToModel(box, center, maxDim);
        this._homeView = { position: this.camera.position.clone(), target: this.controls.target.clone() };
      } catch (e) { console.warn('[SpatialViewer] shadow fit failed:', e); }
    } else {
      // keep modelRadius representative of the biggest layer
      this.modelRadius = Math.max(this.modelRadius || 0, maxDim);
    }

    try { this._applyRenderSettings(); }
    catch (e) { console.warn('[SpatialViewer] post-load render setup failed:', e); }

    this.renderExisting3DAnnotations();

    if (layered) {
      this._harvestLayer(layerId);
    } else {
      this.hideLoader();
    }

    // One-time navigation hint.
    if (this.currentTool === 'orbit' && !this._navHintShown) {
      this._navHintShown = true;
      this.showTooltip('Drag to orbit · scroll to zoom to cursor · <b>W A S D</b> move · <b>R</b> / <b>F</b> up · down · Shift = faster');
      var self = this;
      setTimeout(function() {
        var t = document.getElementById('drawingTooltip');
        if (t && self.currentTool === 'orbit') t.style.display = 'none';
      }, 7000);
    }
  };

  SpatialViewerApp.prototype.createDemoModel = function() {
    this.hideLoader();
    var group = new THREE.Group();
    var mainMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.4, metalness: 0.1 });
    var colMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.6 });
    for (var f = 0; f < 3; f++) {
      var floor = new THREE.Mesh(new THREE.BoxGeometry(16, 0.4, 12), mainMat);
      floor.position.set(0, f * 4, 0);
      group.add(floor);
      for (var x = -7; x <= 7; x += 7) {
        for (var z = -5; z <= 5; z += 5) {
          var col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 3.6, 16), colMat);
          col.position.set(x, f * 4 + 2, z);
          group.add(col);
        }
      }
    }
    this.onModelLoaded(group);
  };

