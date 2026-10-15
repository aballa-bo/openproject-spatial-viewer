using System;
using System.IO;
using System.Threading.Tasks;
using GLTFast;
using UnityEngine;

namespace SpatialViewer.Loaders
{
    /// <summary>
    /// Loads one GLB-format layer via glTFast (com.unity.cloud.gltfast),
    /// the C# equivalent of viewer_engine.js's _parseGltf/THREE.GLTFLoader
    /// path. M0 scope: a single local .glb file, no textures-over-network,
    /// no draco/meshopt extension validation beyond what glTFast handles
    /// itself.
    /// </summary>
    public static class GlbLayerLoader
    {
        public static async Task<GameObject> LoadAsync(string glbFilePath, Transform parent)
        {
            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(glbFilePath);
            }
            catch (IOException e)
            {
                Debug.LogError($"[SpatialViewer] Could not read {glbFilePath}: {e.Message}");
                return null;
            }

            var gltf = new GltfImport();
            // The base URI matters for resolving any relative external
            // references inside the glTF; a plain .glb is self-contained,
            // but pass it anyway per glTFast's own runtime-loading guidance.
            bool loaded = await gltf.LoadGltfBinary(bytes, new Uri(glbFilePath));
            if (!loaded)
            {
                Debug.LogError($"[SpatialViewer] glTFast failed to parse {glbFilePath}");
                gltf.Dispose();
                return null;
            }

            var root = new GameObject(Path.GetFileNameWithoutExtension(glbFilePath));
            root.transform.SetParent(parent, false);

            bool instantiated = await gltf.InstantiateMainSceneAsync(root.transform);
            if (!instantiated)
            {
                Debug.LogError($"[SpatialViewer] glTFast failed to instantiate {glbFilePath}");
                UnityEngine.Object.Destroy(root);
                gltf.Dispose();
                return null;
            }

            return root;
        }
    }
}
