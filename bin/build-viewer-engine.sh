#!/bin/bash
# Assembles app/assets/javascripts/openproject_spatial_viewer/viewer_engine.js
# from the ordered fragments under .../openproject_spatial_viewer/engine/.
#
# viewer_engine.js is split into those fragments for editing (one file per
# subsystem instead of one 7000+ line file), but it still has to ship as a
# SINGLE script: the whole thing lives inside one `(function() { ... })()`
# closure (the registration guard, the SpatialViewerApp constructor, and
# every module-scope helper function all share that one scope), and the
# fragments are plain slices of it with no closure of their own -- they are
# only ever valid concatenated in this exact order. The generated file is
# not committed (see .gitignore); this script regenerates it from source,
# and install.sh always runs it before deploying.
set -e

JS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/app/assets/javascripts/openproject_spatial_viewer"
ENGINE_DIR="$JS_DIR/engine"
OUT="$JS_DIR/viewer_engine.js"

FRAGMENTS="
00_prelude.js
10_core.js
20_model_loading.js
30_interaction_lasso.js
40_annotations.js
50_ui_vr_ar.js
"

tmp="$OUT.build.tmp"
: > "$tmp"
for f in $FRAGMENTS; do
  path="$ENGINE_DIR/$f"
  if [ ! -f "$path" ]; then
    echo "[-] ERROR: missing fragment $path" >&2
    rm -f "$tmp"
    exit 1
  fi
  cat "$path" >> "$tmp"
done
mv "$tmp" "$OUT"
echo "[+] Built $OUT from $(echo "$FRAGMENTS" | grep -c .) fragments ($(wc -l < "$OUT") lines)"
