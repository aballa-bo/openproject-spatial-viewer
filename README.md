# OpenProject Spatial Viewer

Project module for OpenProject that adds a **3D viewer** with **annotation**
tools that link to Work Packages.

Supported formats:

| Format | Status |
|---|---|
| glTF / GLB | working (`THREE.GLTFLoader`) |
| OBJ / Wavefront | working (`THREE.OBJLoader`) |
| PLY / Gaussian Splatting (`.ply`, `.splat`, `.ksplat`) | working as a point cloud |
| IFC (BIM) | server-side `IfcConvert` → GLB, then rendered as GLB — see *IFC* |

Tested on OpenProject 16.6.

## Features

- WebGL viewer built on Three.js r128 (bundled in
  `app/assets/javascripts/openproject_spatial_viewer/vendor.bundle.js`).
- 3D markup tools: surface pin, polyline (points land exactly on the model
  surface), lasso, distance measurement. Sampling is screen-space and uses
  coalesced pointer events, so density is dense and scale-independent.
- **The lasso is a screen-space gesture — it casts no rays while drawing.** The
  path is collected in canvas pixels (interpolated to ~2 px) and stroked on a 2D
  overlay canvas with `closePath()`, so it is dense, visibly closed *during* the
  drag, and identical on a 10-triangle box or a 2-million-triangle scan.
- The highlight re-renders the model's **own geometry** with a tint shader
  (`LASSO_FS`) that discards fragments outside the polygon (tested in NDC
  against `gl_FragCoord`); `depthTest` keeps only the front-most surface. The
  tint is pixel-exact on the visible surface — no offset, no speckle, correct
  occlusion — and identical for glb / ifc / gaussian-splat. It updates live
  while drawing (uniform refresh only) and is rebuilt from the stored viewpoint
  when an annotation is opened.
- Only at pointer-up is the screen ring down-sampled to ≤64 points and
  projected to 3D for storage (rays that miss the mesh fall back to the focal
  plane, so the stored ring always has the drawn shape).
- The free-hand polyline tool still raycasts per point, but with a hard budget
  of 8 rays per pointer event so a heavy mesh cannot stall the UI.
- `vendor/mesh-bvh.js` (three-mesh-bvh 0.5.23) accelerates those raycasts;
  trees are built once (`_ensureBVH`), and the library self-loads if the hook
  did not emit its `<script>`.
- The pointer is captured on stroke start, so a stroke that leaves the viewport
  does not end early.
- Annotations follow the **BCF** data model and are always tied to a Work
  Package — see *Annotations & BCF*.
- Section planes (X/Y/Z clipping), preset views (top/front/right/iso).
- Dedicated permissions: `view_spatial_models`, `manage_spatial_models`,
  `create_spatial_annotations`.

## Layout

```
app/
  controllers/   spatial_models_controller.rb, spatial_annotations_controller.rb
  models/        spatial_model.rb, spatial_annotation.rb  (both acts_as_attachable)
  services/spatial_viewer/   ifc_converter.rb, annotation_bcf_sync.rb
  workers/spatial_viewer/    convert_ifc_job.rb, sync_annotation_bcf_job.rb
  views/spatial_models/      index, new, edit, _form, show (show.html.erb = the viewer)
  assets/
    javascripts/openproject_spatial_viewer/
      viewer_engine.js     viewer logic + Turbo Drive integration
      vendor.bundle.js     THREE + OrbitControls + GLTFLoader + OBJLoader + PLYLoader
      vendor/              standalone loaders + web-ifc (currently unused)
    stylesheets/openproject_spatial_viewer/viewer.css
config/
  routes.rb, locales/en.yml
db/migrate/     create_spatial_models, create_spatial_annotations
lib/open_project/spatial_viewer/
  engine.rb      module registration, menu, permissions
  hooks.rb       injects CSS/JS into <head> (only on the viewer pages)
  patches/       project_patch.rb, attachment_patch.rb
```

All user-facing strings are English. `en.yml` is the fallback for every
locale; there is intentionally no per-language locale file.

## Installation

```bash
sudo bash install.sh
```

Copies the plugin to `/opt/openproject/modules/spatial_viewer`, adds it to
`Gemfile.modules`, runs `bundle install` and `db:migrate`, copies static assets
to `public/assets/openproject_spatial_viewer/`, checks for `IfcConvert`, and
restarts the services (`openproject-web-1` and `openproject-worker-1`).

### Quick redeploy of a single changed file

```bash
sudo cp app/assets/javascripts/openproject_spatial_viewer/viewer_engine.js \
   /opt/openproject/modules/spatial_viewer/app/assets/javascripts/openproject_spatial_viewer/
sudo cp app/assets/javascripts/openproject_spatial_viewer/viewer_engine.js \
   /opt/openproject/public/assets/openproject_spatial_viewer/
sudo -u openproject bash -lc 'cd /opt/openproject && bundle exec rake tmp:cache:clear'
sudo systemctl restart openproject-web-1 openproject-worker-1
```

Then hard-reload the browser (Ctrl+Shift+R) so the new `viewer_engine.js` is
fetched instead of the cached copy.

## Annotations & BCF

Every annotation is a **viewpoint tied to a Work Package**, mirroring the BCF
2.1 structure used by OpenProject's BIM module:

| Plugin | BCF equivalent |
|---|---|
| `SpatialAnnotation` | `Bim::Bcf::Viewpoint` (camera, lines, clipping planes, snapshot) |
| `SpatialAnnotation#work_package` | `Bim::Bcf::Issue#work_package` (the topic) |
| `SpatialAnnotation#json_viewpoint` | BCF 2.1 viewpoint JSON (built in `to_bcf_viewpoint_json`) |
| snapshot attachment (`description: "snapshot"`) | BCF viewpoint snapshot |

Placing a pin / drawing / measuring opens an inline **"New Work Package"
panel beside the viewer** (like the BCF split view), not a modal overlay:
subject, type, priority, assignee, description — or "Link existing" to pick
a Work Package. The 3D viewport stays interactive on the left.

Flow on save (`SpatialAnnotationsController#create`):

1. A Work Package is resolved — the one selected, or a new one created via
   `WorkPackages::CreateService` from the panel fields. `work_package` is
   mandatory.
2. The canvas snapshot (data URI) is stored as a real attachment.
3. `json_viewpoint` is computed from the camera + drawing geometry, converting
   the viewer's Y-up coordinates to the BCF/IFC Z-up convention.
4. `SpatialViewer::SyncAnnotationBcfJob` mirrors the annotation into
   `Bim::Bcf::Issue` + `Bim::Bcf::Viewpoint` (keyed by `viewpoint_uuid`),
   running as the system user. The snapshot is copied to the BCF viewpoint.

Result: the annotation shows up in the **"BCF" section of the Work Package
page** (thumbnail gallery), and in the plugin viewer's side panel (thumbnail +
WP link; click restores the camera).

### Requirements / degradation

- The `Bim::Bcf` models are always present (bundled module), but the BCF group
  only appears on the WP page when the project has the **BIM module enabled**
  and the role has `view_linked_issues`.
- Without BIM, the mirror step is a no-op and annotations live only in the
  plugin viewer's panel (still linked to the WP, reachable via its link).

### Known limits

- Component selection/coloring (`ifc_guid`) is not populated — our OBJ/PLY
  models have no IFC GUIDs, and IFC is served as converted GLB.
- Clicking a viewpoint thumbnail *on the WP page* targets OpenProject's own IFC
  viewer, not this plugin's viewer. Camera restore across the two viewers is
  best-effort (axis conventions differ).
- BCF comments ↔ Work Package journal are not wired yet (follow-up).

## IFC

IFC is not rendered client-side: it is **converted to GLB on the server** and
the viewer loads the GLB (which already works).

Pipeline:

1. On upload (`create`/`update`) or first open, `SpatialModel#enqueue_conversion`
   schedules `SpatialViewer::ConvertIfcJob`.
2. The job runs `SpatialViewer::IfcConverter`:
   `IfcConvert -q -y --no-progress --center-model <in.ifc> <out.glb>`.
3. The GLB is cached at
   `<attachments_storage_path>/spatial_viewer/<model_id>/model.glb`.
4. Status (`pending` / `processing` / `completed` / `error` + message) is stored
   in `spatial_models.settings["conversion"]` and exposed by `api_data` in the
   `conversion` field. Until it is `completed`, `model_file` returns JSON and the
   viewer polls, showing "Converting IFC on the server".
5. The cache is invalidated automatically when the attachment changes
   (`conversion.attachment_id`) and removed when the model is deleted.

### Requirements / configuration

- The `IfcConvert` binary (IfcOpenShell). Looked up in: `IFCCONVERT_BIN`,
  `<Rails.root>/bin/IfcConvert`, `/opt/openproject/bin/IfcConvert`, `$PATH`.
  The OpenProject BIM module already installs it at `bin/IfcConvert`.
- `attachment_max_size`: for this module the limit is **bypassed**
  (`AttachmentPatch#internal_container?`), so large IFC files still attach.
  Watch disk space.
- Environment variables:
  - `SPATIAL_VIEWER_MAX_IFC_MB` (default `300`) — above this the conversion is
    rejected with a message pointing to the BIM module.
  - `SPATIAL_VIEWER_CONVERT_TIMEOUT` (default `1800` seconds).

### Large models

- `gltf_worker.js` parses GLB/GLTF in a **Web Worker** (no main-thread freeze),
  transferring de-interleaved geometry back to the viewer. Textured / Draco /
  meshopt models fall back to a main-thread `GLTFLoader.parse()`.
- The download is buffered through a `Blob` and the `ArrayBuffer` is transferred
  to the worker, so it is not held on the main-thread heap during parsing.
- A `HEAD` request checks the size first: above `data-max-model-mb` (default
  250) the viewer asks for confirmation before downloading.
- Above `data-heavy-model-mb` (default 40), or >4M triangles, "heavy mode"
  turns off shadows and caps `pixelRatio` at 1.
- Still not solved: no Draco/meshopt/KTX2 decoders (compressed GLB fails with a
  clear error), no BVH raycast, no LOD. Very large models (multi-hundred-MB
  Revit exports) are still better served by the BIM module's XKT/xeokit viewer.
- `IfcConvert` may log `Triangulation missing for face` on problematic geometry:
  these are warnings, conversion continues.
- `vendor/web-ifc*.js` and `vendor/IFCLoader*.js` are currently unused (kept for
  a possible future client-side path).

## History

The plugin was originally generated by Python scripts (`build_plugin.py`,
`write_spatial_engine.py`, …). That approach was **abandoned**: this repository
is now the source of truth. Do not regenerate from those scripts.
