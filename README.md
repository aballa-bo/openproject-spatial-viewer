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
- 3D markup tools: surface pin, polyline on mesh, lasso/region selection,
  distance measurement.
- Each annotation stores a camera viewpoint + thumbnail and can create or link
  a Work Package.
- Section planes (X/Y/Z clipping), preset views (top/front/right/iso).
- Dedicated permissions: `view_spatial_models`, `manage_spatial_models`,
  `create_spatial_annotations`.

## Layout

```
app/
  controllers/   spatial_models_controller.rb, spatial_annotations_controller.rb
  models/        spatial_model.rb (acts_as_attachable), spatial_annotation.rb
  services/spatial_viewer/   ifc_converter.rb
  workers/spatial_viewer/    convert_ifc_job.rb
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

### Known limits

- Very large models (e.g. multi-hundred-MB Revit exports) produce GLB files too
  heavy for the browser: use the native IFC viewer in the OpenProject BIM module
  (XKT/xeokit, designed for that scale).
- `IfcConvert` may log `Triangulation missing for face` on problematic geometry:
  these are warnings, conversion continues.
- `vendor/web-ifc*.js` and `vendor/IFCLoader*.js` are currently unused (kept for
  a possible future client-side path).

## History

The plugin was originally generated by Python scripts (`build_plugin.py`,
`write_spatial_engine.py`, …). That approach was **abandoned**: this repository
is now the source of truth. Do not regenerate from those scripts.
