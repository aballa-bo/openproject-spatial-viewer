using System.IO;
using SpatialViewer.Loaders;
using UnityEngine;

namespace SpatialViewer.Bootstrap
{
    /// <summary>
    /// Entry point for the standalone player. M0 scope: read config.json +
    /// data/manifest.json next to the executable, load the first "glb"
    /// layer, frame the camera on it. Later milestones replace the
    /// single-layer lookup with the full layer loop + UI.
    /// </summary>
    public class AppBootstrap : MonoBehaviour
    {
        private async void Start()
        {
            var exeDir = GetExeDir();
            var configPath = Path.Combine(exeDir, "config.json");
            var manifestPath = Path.Combine(exeDir, "data", "manifest.json");

            if (!File.Exists(manifestPath))
            {
                Debug.LogError($"[SpatialViewer] No manifest found at {manifestPath}. " +
                                "This build must be run from inside the folder the \"Download as .exe\" " +
                                "zip was extracted to, not launched standalone.");
                return;
            }

            var config = File.Exists(configPath) ? AppConfig.Load(configPath) : new AppConfig();
            var manifest = ExportManifest.Load(manifestPath);
            Debug.Log($"[SpatialViewer] Loaded manifest for \"{manifest.Title}\" " +
                      $"(project {manifest.ProjectId}, model {manifest.ModelId}), server: {config.ServerBaseUrl}");

            var dataDir = Path.Combine(exeDir, "data");
            var sceneRoot = new GameObject("Model");

            foreach (var layer in manifest.Layers)
            {
                if (layer.Format != "glb")
                {
                    Debug.LogWarning($"[SpatialViewer] Skipping layer \"{layer.Title}\": " +
                                      $"format \"{layer.Format}\" isn't supported yet (M0 only loads glb).");
                    continue;
                }

                // layer.Path is written as "data/layers/....", already rooted
                // at the zip root -- exeDir is that same root once extracted.
                var layerPath = Path.Combine(exeDir, layer.Path);
                await GlbLayerLoader.LoadAsync(layerPath, sceneRoot.transform);
            }

            FrameCamera(sceneRoot);
        }

        // Application.dataPath is "<exeDir>/<ProductName>_Data" in a
        // standalone build, and "<ProjectDir>/Assets" in the editor.
        private static string GetExeDir() => Directory.GetParent(Application.dataPath)?.FullName ?? ".";

        private static void FrameCamera(GameObject root)
        {
            var cam = Camera.main;
            if (cam == null) return;

            var renderers = root.GetComponentsInChildren<Renderer>();
            if (renderers.Length == 0) return;

            var bounds = renderers[0].bounds;
            foreach (var r in renderers) bounds.Encapsulate(r.bounds);

            var maxDim = Mathf.Max(bounds.size.x, bounds.size.y, bounds.size.z);
            cam.transform.position = bounds.center + new Vector3(1.5f, 1.2f, 1.5f) * maxDim;
            cam.transform.LookAt(bounds.center);
        }
    }
}
