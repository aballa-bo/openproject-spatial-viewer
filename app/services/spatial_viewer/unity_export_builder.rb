# frozen_string_literal: true

require "zip"

module SpatialViewer
  # Packages a SpatialModel into a "Download as .exe" zip: the prebuilt,
  # generic Unity standalone player (built once, out of band, by whoever has
  # Unity Editor -- this server has none and never builds Unity itself) plus
  # this model's already-converted layer files and a manifest mirroring
  # SpatialModelsController#api_data's shape, with local relative paths
  # instead of URLs. The player tree is reused unchanged for every download;
  # only the data/ folder and config.json are generated per model.
  #
  # Security: config.json's api_key is always blank. The desktop app asks the
  # end user for their own OpenProject personal API key on first run and
  # keeps it only in local app data -- it is never embedded in this zip.
  class UnityExportBuilder
    class BuildError < StandardError; end

    def self.player_dir
      Pathname(ENV.fetch("SPATIAL_VIEWER_UNITY_PLAYER_DIR",
                          SpatialModel.conversion_storage_root.join("..", "unity_player").to_s))
    end

    def self.player_available?
      dir = player_dir
      dir.directory? && !Dir.children(dir).empty?
    rescue Errno::ENOENT
      false
    end

    def initialize(model, server_base_url:)
      @model = model
      @server_base_url = server_base_url
    end

    # Returns a Tempfile holding the zip. The caller owns its lifecycle (hand
    # it to Rack's tempfile reaper before `send_file`-ing its path).
    def call
      unless self.class.player_available?
        raise BuildError, "The Unity player has not been deployed on this server yet. " \
                           "See README.md for the one-time build + deploy step."
      end

      tmp = Tempfile.new(["spatial_viewer_export_#{@model.id}_", ".zip"], binmode: true)
      Zip::OutputStream.open(tmp.path) do |zos|
        write_player_tree(zos)
        write_data_files(zos)
        write_manifest(zos)
        write_config(zos)
      end
      tmp
    end

    private

    # Copies the prebuilt player tree in verbatim, unchanged, under the zip root.
    def write_player_tree(zos)
      base = self.class.player_dir
      Dir.glob(base.join("**", "*"), File::FNM_DOTMATCH).each do |path|
        next if File.directory?(path) || %w[. ..].include?(File.basename(path))

        write_entry(zos, Pathname(path).relative_path_from(base).to_s, path)
      end
    end

    def write_data_files(zos)
      layer_entries.each { |entry| write_entry(zos, entry[:zip_path], entry[:source_path]) }
    end

    def write_entry(zos, zip_path, source_path)
      return unless File.file?(source_path)

      zos.put_next_entry(zip_path)
      IO.copy_stream(File.open(source_path, "rb"), zos)
    end

    def write_manifest(zos)
      zos.put_next_entry("data/manifest.json")
      zos.write(JSON.pretty_generate(manifest))
    end

    def write_config(zos)
      zos.put_next_entry("config.json")
      zos.write(JSON.pretty_generate(server_base_url: @server_base_url, api_key: ""))
    end

    # (M0 scope) a single layer: the model's own attachment, converted if
    # needed. M1 extends this to the full multi-layer list from
    # SpatialModelsController#layers_payload.
    def layer_entries
      return [] if @model.model_attachment.blank?

      converted = @model.needs_conversion? && @model.converted_file_ready?
      source = converted ? @model.converted_file_path.to_s : @model.model_attachment.diskfile.path
      ext = converted ? "glb" : File.extname(@model.model_attachment.filename.to_s).delete(".")
      [{
        id: "model",
        format: @model.viewer_format,
        zip_path: "data/layers/model.#{ext}",
        source_path: source
      }]
    end

    def manifest
      {
        project_id: @model.project_id,
        model_id: @model.id,
        title: @model.title,
        description: @model.description,
        settings: @model.settings,
        layers: layer_entries.map { |e| { id: e[:id], title: @model.title, format: e[:format], path: e[:zip_path] } }
      }
    end
  end
end
