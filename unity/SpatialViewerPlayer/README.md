# SpatialViewerPlayer (Unity)

The generic desktop player packaged by "Download as .exe" in the web viewer.
One build of this project is reused, unchanged, for every model — the Rails
plugin only zips this build together with a per-model `data/` folder at
download time (see `app/services/spatial_viewer/unity_export_builder.rb` in
the repo root).

**This cannot be built or tested on the OpenProject server** — it has no
Unity Editor, no Windows build tools, no GPU. Build it on your own Windows
(or Mac, for editing) machine with Unity Editor installed.

## Milestone status

This currently covers **M0** only: load one GLB-format layer, no UI, no
navigation, no annotations, no auth. See the project's implementation plan
for the full milestone sequence (core rendering/navigation parity → live
annotation/Work Package sync → creating annotations from Unity → VR →
Gaussian Splatting).

## One-time setup

1. Install **Unity Hub** + a recent **Unity 6 LTS** editor (any 6.x LTS is
   fine; pin the exact version you used in this file once you've built it,
   so later milestones target the same editor).
2. In Unity Hub, "Add project from disk" and point it at this folder
   (`unity/SpatialViewerPlayer/`). Unity will generate the missing
   `ProjectSettings/` on first open — that's expected, it isn't checked into
   git here.
3. Open **Window → Package Manager** and confirm `com.unity.cloud.gltfast`
   and `com.unity.nuget.newtonsoft-json` installed (they're declared in
   `Packages/manifest.json`; Unity resolves them automatically on open — if
   it doesn't, add them manually from the Unity registry).
4. Create an empty scene with one empty GameObject named `Bootstrap` and
   attach the `AppBootstrap` component (`Assets/Scripts/Bootstrap/AppBootstrap.cs`)
   to it. Add a `Main Camera` if the default scene doesn't already have one.
5. **Build Settings → PC, Mac & Linux Standalone → target Windows x64 →
   Build**, output into `dist/` right here in this folder
   (`unity/SpatialViewerPlayer/dist/`). That `dist/` folder is exactly what
   `install.sh` looks for and deploys to the server.
6. Back on the server: `sudo bash install.sh` — step 7/8 copies `dist/` into
   place and the "Download as .exe" button appears in the viewer.

## Runtime data contract

At runtime (in the built .exe, not the editor) `AppBootstrap` reads, next to
the executable:
- `config.json` — `{ "server_base_url": "...", "api_key": "" }`. The zip
  always ships this with a blank `api_key`; later milestones prompt the user
  for their own OpenProject personal API key and persist it to
  `Application.persistentDataPath` instead, never back into this file.
- `data/manifest.json` — the per-model manifest (mirrors the web viewer's
  `api_data` JSON shape, but with local relative file paths under `data/`
  instead of URLs). See `ManifestModels.cs` for the exact fields.
- `data/layers/...` — the actual model files referenced by the manifest.
