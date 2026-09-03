# OpenProject Spatial Viewer

Modulo di progetto per OpenProject che aggiunge un **visualizzatore 3D** con
strumenti di **annotazione** collegabili ai Work Package.

Formati supportati:

| Formato | Stato |
|---|---|
| glTF / GLB | funzionante (`THREE.GLTFLoader`) |
| OBJ / Wavefront | funzionante (`THREE.OBJLoader`) |
| PLY / Gaussian Splatting (`.ply`, `.splat`, `.ksplat`) | funzionante come point cloud |
| IFC (BIM) | conversione server-side IFC → GLB con `IfcConvert` — vedi *IFC* |

Testato su OpenProject 16.6.

## Funzionalità

- Viewer WebGL basato su Three.js r128 (bundle in `app/assets/javascripts/openproject_spatial_viewer/vendor.bundle.js`).
- Strumenti di markup 3D: pin sulla superficie, polilinea sulla mesh, lazo/selezione regione, misura distanza.
- Ogni annotazione salva un viewpoint camera + thumbnail e può creare o collegare un Work Package.
- Piani di sezione (clipping X/Y/Z), viste preimpostate (top/front/right/iso).
- Permessi dedicati: `view_spatial_models`, `manage_spatial_models`, `create_spatial_annotations`.

## Struttura

```
app/
  controllers/   spatial_models_controller.rb, spatial_annotations_controller.rb
  models/        spatial_model.rb (acts_as_attachable), spatial_annotation.rb
  views/spatial_models/   index, new, edit, _form, show (show.html.erb = il viewer)
  assets/
    javascripts/openproject_spatial_viewer/
      viewer_engine.js     logica viewer + integrazione Turbo Drive
      vendor.bundle.js     THREE + OrbitControls + GLTFLoader + OBJLoader + PLYLoader
      vendor/              loader singoli + web-ifc (non ancora integrati nel bundle)
    stylesheets/openproject_spatial_viewer/viewer.css
config/
  routes.rb, locales/{en,it}.yml
db/migrate/     create_spatial_models, create_spatial_annotations
lib/open_project/spatial_viewer/
  engine.rb      registrazione modulo, menu, permessi
  hooks.rb       inietta CSS/JS nell'head (solo sulle pagine del viewer)
  patches/       project_patch.rb, attachment_patch.rb
```

## Installazione

```bash
sudo bash install.sh
```

Lo script copia il plugin in `/opt/openproject/modules/spatial_viewer`, lo aggiunge
a `Gemfile.modules`, esegue `bundle install`, `db:migrate`, copia gli asset statici
in `public/assets/openproject_spatial_viewer/` e riavvia i servizi.

### Deploy rapido di un solo file modificato

```bash
sudo cp app/assets/javascripts/openproject_spatial_viewer/viewer_engine.js \
   /opt/openproject/modules/spatial_viewer/app/assets/javascripts/openproject_spatial_viewer/
sudo cp app/assets/javascripts/openproject_spatial_viewer/viewer_engine.js \
   /opt/openproject/public/assets/openproject_spatial_viewer/
sudo -u openproject bash -lc 'cd /opt/openproject && bundle exec rake tmp:cache:clear'
sudo systemctl restart openproject-web-1 openproject-worker-1
```

## Note operative

- **Dimensione allegati**: OpenProject limita gli allegati a 5 MB di default
  (`attachment_max_size`). Gli IFC quasi sempre lo superano: se il file viene
  rifiutato il modello resta senza allegato e il viewer mostra un modello di
  esempio. Alzare il limite in *Amministrazione → Allegati*.
- Gli script/JS sono iniettati nell'`<head>` da `hooks.rb` e caricati in modo
  asincrono; `viewer_engine.js` attende che `THREE` sia disponibile prima di
  inizializzare, per compatibilità con le navigazioni Turbo Drive.

## IFC

Gli IFC non sono renderizzati lato client: vengono **convertiti sul server in
GLB** e il viewer carica il GLB (che già funziona).

Pipeline:

1. All'upload (`create`/`update`) o alla prima apertura, `SpatialModel#enqueue_conversion`
   accoda `SpatialViewer::ConvertIfcJob`.
2. Il job invoca `SpatialViewer::IfcConverter`, che esegue
   `IfcConvert -q -y --no-progress --center-model <in.ifc> <out.glb>`.
3. Il GLB viene messo in cache in
   `<attachments_storage_path>/spatial_viewer/<model_id>/model.glb`.
4. Lo stato (`pending` / `processing` / `completed` / `error` + messaggio) è
   salvato in `spatial_models.settings["conversion"]` ed esposto da `api_data`
   nel campo `conversion`. Finché non è `completed`, `model_file` risponde JSON
   e il viewer fa polling mostrando "Conversione in corso".
5. La cache viene invalidata automaticamente quando cambia l'allegato
   (`conversion.attachment_id`) e rimossa alla cancellazione del modello.

### Requisiti / configurazione

- Binario `IfcConvert` (IfcOpenShell). Cercato in: `IFCCONVERT_BIN`,
  `<Rails.root>/bin/IfcConvert`, `/opt/openproject/bin/IfcConvert`, `$PATH`.
  Il modulo BIM di OpenProject lo installa già in `bin/IfcConvert`.
- `attachment_max_size`: per il modulo spatial il limite è **bypassato**
  (`AttachmentPatch#internal_container?`), quindi gli IFC grandi si allegano
  comunque. Attenzione però allo spazio disco.
- Variabili d'ambiente:
  - `SPATIAL_VIEWER_MAX_IFC_MB` (default `300`) — sopra questa soglia la
    conversione viene rifiutata con un messaggio che rimanda al modulo BIM.
  - `SPATIAL_VIEWER_CONVERT_TIMEOUT` (default `1800` s).

### Limiti noti

- Modelli molto grandi (es. export Revit da centinaia di MB) producono GLB
  troppo pesanti per il browser: usare il visualizzatore IFC nativo del
  modulo BIM di OpenProject (basato su XKT/xeokit, pensato per quei volumi).
- `IfcConvert` può loggare `Triangulation missing for face` su geometrie
  problematiche: sono warning, la conversione prosegue.
- I file client-side `vendor/web-ifc*.js`, `vendor/IFCLoader*.js` non sono più
  usati (restano per un'eventuale futura resa lato client).

## Storico

Il plugin era in origine generato da script Python (`build_plugin.py`,
`write_spatial_engine.py`, …). Quell'approccio è stato **abbandonato**: il
sorgente autoritativo è ora questo repository. Non rigenerare da quegli script.
