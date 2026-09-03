# OpenProject Spatial Viewer

Modulo di progetto per OpenProject che aggiunge un **visualizzatore 3D** con
strumenti di **annotazione** collegabili ai Work Package.

Formati supportati:

| Formato | Stato |
|---|---|
| glTF / GLB | funzionante (`THREE.GLTFLoader`) |
| OBJ / Wavefront | funzionante (`THREE.OBJLoader`) |
| PLY / Gaussian Splatting (`.ply`, `.splat`, `.ksplat`) | funzionante come point cloud |
| IFC (BIM) | **parziale** — vedi *Limitazioni IFC* |

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

## Limitazioni IFC

Il bundle non contiene un loader IFC reale. `viewer_engine.js` estrae solo i
punti `IFCCARTESIANPOINT` via regex e li mostra come point cloud grezzo (senza
trasformazioni di local placement). Per un rendering BIM corretto:

1. integrare `web-ifc` + `IFCLoader` (file già presenti in `vendor/`), oppure
2. conversione server-side IFC → GLB (IfcOpenShell / `IfcConvert`) in un job di
   background, servendo il GLB da `SpatialModelsController#model_file`.

## Storico

Il plugin era in origine generato da script Python (`build_plugin.py`,
`write_spatial_engine.py`, …). Quell'approccio è stato **abbandonato**: il
sorgente autoritativo è ora questo repository. Non rigenerare da quegli script.
