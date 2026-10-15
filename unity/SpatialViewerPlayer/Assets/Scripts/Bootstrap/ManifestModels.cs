using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SpatialViewer.Bootstrap
{
    /// <summary>
    /// Mirrors the JSON written by SpatialViewer::UnityExportBuilder
    /// (app/services/spatial_viewer/unity_export_builder.rb) into
    /// data/manifest.json inside the downloaded zip. Field names match the
    /// Rails JSON exactly (snake_case) via JsonProperty, not C# convention.
    /// Kept loosely typed (JToken) for settings/annotation payloads, since
    /// those are open jsonb hashes on the Rails side whose shape can grow
    /// across milestones without this DTO needing to change.
    /// </summary>
    public class ExportManifest
    {
        [JsonProperty("project_id")] public int ProjectId;
        [JsonProperty("model_id")] public int ModelId;
        [JsonProperty("title")] public string Title;
        [JsonProperty("description")] public string Description;
        [JsonProperty("settings")] public JToken Settings;
        [JsonProperty("layers")] public ManifestLayer[] Layers = System.Array.Empty<ManifestLayer>();

        public static ExportManifest Load(string jsonPath)
        {
            var json = System.IO.File.ReadAllText(jsonPath);
            return JsonConvert.DeserializeObject<ExportManifest>(json);
        }
    }

    public class ManifestLayer
    {
        [JsonProperty("id")] public string Id;
        [JsonProperty("title")] public string Title;
        [JsonProperty("format")] public string Format;
        // Relative to the folder data/manifest.json lives in (e.g. "data/layers/model.glb").
        [JsonProperty("path")] public string Path;
    }

    /// <summary>
    /// Mirrors config.json. The zip always ships api_key blank (see
    /// UnityExportBuilder#write_config) -- a later milestone's
    /// ApiKeyStore/FirstRunApiKeyPrompt persists the user's own key to
    /// Application.persistentDataPath instead of writing back here.
    /// </summary>
    public class AppConfig
    {
        [JsonProperty("server_base_url")] public string ServerBaseUrl;
        [JsonProperty("api_key")] public string ApiKey = "";

        public static AppConfig Load(string jsonPath)
        {
            var json = System.IO.File.ReadAllText(jsonPath);
            return JsonConvert.DeserializeObject<AppConfig>(json);
        }
    }
}
