# frozen_string_literal: true

require "open3"
require "timeout"
require "tmpdir"
require "shellwords"

module SpatialViewer
  # Converts an uploaded IFC file into a binary glTF (.glb) that the WebGL
  # viewer can load directly, using the IfcOpenShell `IfcConvert` binary that
  # ships with OpenProject's BIM module.
  #
  # The result is cached on disk (see SpatialModel#converted_file_path) and
  # only regenerated when the underlying attachment changes.
  class IfcConverter
    class ConversionError < StandardError; end

    DEFAULT_MAX_MB = 300
    DEFAULT_TIMEOUT_SECONDS = 30 * 60

    def initialize(model)
      @model = model
    end

    def self.ifcconvert_available?
      new(nil).send(:ifcconvert_bin).present?
    end

    def call
      attachment = @model.model_attachment
      raise ConversionError, "Nessun file IFC allegato al modello" unless attachment

      source = local_ifc_path(attachment)
      raise ConversionError, "File IFC non trovato su disco" unless source && File.file?(source)

      size_mb = File.size(source) / 1_048_576.0
      if size_mb > max_mb
        raise ConversionError,
              "IFC troppo grande (#{size_mb.round} MB, limite #{max_mb} MB). " \
              "Per modelli di queste dimensioni usa il modulo BIM di OpenProject, " \
              "oppure aumenta la variabile d'ambiente SPATIAL_VIEWER_MAX_IFC_MB."
      end

      ensure_free_disk!(source)

      Dir.mktmpdir("spatial_ifc") do |dir|
        linked = File.join(dir, "model.ifc")
        FileUtils.ln_s(File.expand_path(source), linked)
        output = File.join(dir, "model.glb")

        run_ifcconvert!(linked, output)

        unless File.file?(output) && File.size(output).positive?
          raise ConversionError, "IfcConvert non ha prodotto alcun output (nessuna geometria?)"
        end

        FileUtils.mkdir_p(@model.conversion_dir)
        FileUtils.mv(output, @model.converted_file_path.to_s, force: true)
        FileUtils.chmod(0o644, @model.converted_file_path.to_s)
      end

      @model.update_conversion_state(
        status: "completed",
        attachment_id: attachment.id,
        message: nil,
        converted_at: Time.current,
        output_bytes: File.size(@model.converted_file_path)
      )
      true
    rescue ConversionError => e
      @model&.update_conversion_state(status: "error", attachment_id: @model.model_attachment&.id, message: e.message)
      raise
    end

    private

    def run_ifcconvert!(input, output)
      bin = ifcconvert_bin
      unless bin
        raise ConversionError,
              "IfcConvert non trovato. Installa IfcOpenShell o imposta la variabile IFCCONVERT_BIN."
      end

      cmd = [bin, "-q", "-y", "--no-progress", "--center-model", input, output]
      stdout = stderr = ""
      status = nil

      begin
        Timeout.timeout(timeout_seconds) do
          stdout, stderr, status = Open3.capture3(*cmd)
        end
      rescue Timeout::Error
        raise ConversionError, "Conversione IFC scaduta dopo #{(timeout_seconds / 60.0).round} minuti"
      end

      return if status&.success?

      detail = (stderr.presence || stdout).to_s.strip[0, 500]
      raise ConversionError, "IfcConvert terminato con codice #{status&.exitstatus}: #{detail}"
    end

    def ifcconvert_bin
      return @ifcconvert_bin if defined?(@ifcconvert_bin)

      candidates = [
        ENV["IFCCONVERT_BIN"],
        Rails.root.join("bin/IfcConvert").to_s,
        "/opt/openproject/bin/IfcConvert"
      ].compact

      @ifcconvert_bin = candidates.find { |c| File.executable?(c) } || from_path
    end

    def from_path
      path, status = Open3.capture2e("which", "IfcConvert")
      status.success? ? path.strip.presence : nil
    rescue StandardError
      nil
    end

    def local_ifc_path(attachment)
      attachment.diskfile&.path
    rescue StandardError
      nil
    end

    def ensure_free_disk!(source)
      target = Dir.tmpdir
      free_kb = `df -kP #{Shellwords.escape(target)}`.lines.last.to_s.split[3].to_i
      needed_kb = (File.size(source) / 1024) * 3
      if free_kb.positive? && free_kb < needed_kb
        raise ConversionError,
              "Spazio su disco insufficiente per la conversione " \
              "(#{(free_kb / 1_048_576.0).round(1)} GB liberi, ne servono ~#{(needed_kb / 1_048_576.0).round(1)} GB)"
      end
    rescue ConversionError
      raise
    rescue StandardError
      nil # never block conversion because the free-space probe failed
    end

    def max_mb
      Integer(ENV.fetch("SPATIAL_VIEWER_MAX_IFC_MB", DEFAULT_MAX_MB.to_s))
    rescue ArgumentError
      DEFAULT_MAX_MB
    end

    def timeout_seconds
      Integer(ENV.fetch("SPATIAL_VIEWER_CONVERT_TIMEOUT", DEFAULT_TIMEOUT_SECONDS.to_s))
    rescue ArgumentError
      DEFAULT_TIMEOUT_SECONDS
    end
  end
end
