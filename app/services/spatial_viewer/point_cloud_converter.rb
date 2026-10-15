# frozen_string_literal: true

require "open3"
require "timeout"
require "tmpdir"
require "fileutils"

module SpatialViewer
  # Converts a compressed / proprietary point cloud (.laz, .e57) into an
  # uncompressed .las the WebGL viewer can parse, using PDAL's `pdal translate`.
  #
  # PDAL is not bundled with OpenProject — install it on the host
  # (`apt-get install pdal` on Debian/Ubuntu) or set the PDAL_BIN env var.
  class PointCloudConverter
    class ConversionError < StandardError; end

    DEFAULT_TIMEOUT_SECONDS = 30 * 60

    def initialize(layer)
      @layer = layer
    end

    def self.pdal_available?
      new(nil).send(:pdal_bin).present?
    end

    def call
      attachment = @layer.file_attachment
      raise ConversionError, "No file attached to the layer" unless attachment

      source = attachment.diskfile&.path
      raise ConversionError, "Point cloud file not found on disk" unless source && File.file?(source)

      bin = pdal_bin
      raise ConversionError,
            "PDAL not found. Install it on the server (apt-get install pdal) or set PDAL_BIN " \
            "to convert .laz / .e57 point clouds." unless bin

      ext = File.extname(attachment.filename.to_s).delete(".").downcase

      Dir.mktmpdir("spatial_pc") do |dir|
        linked = File.join(dir, "in.#{ext}")
        FileUtils.ln_s(File.expand_path(source), linked)
        output = File.join(dir, "out.las")

        run!(bin, linked, output)

        unless File.file?(output) && File.size(output).positive?
          raise ConversionError, "pdal translate produced no output"
        end

        FileUtils.mkdir_p(@layer.conversion_dir)
        FileUtils.mv(output, @layer.converted_file_path.to_s, force: true)
        FileUtils.chmod(0o644, @layer.converted_file_path.to_s)
      end

      @layer.update_conversion_state(
        status: "completed",
        attachment_id: attachment.id,
        message: nil,
        converted_at: Time.current,
        output_bytes: File.size(@layer.converted_file_path)
      )
      true
    rescue ConversionError => e
      @layer&.update_conversion_state(
        status: "error", attachment_id: @layer.file_attachment&.id, message: e.message
      )
      raise
    end

    private

    def run!(bin, input, output)
      cmd = [bin, "translate", input, output]
      stdout = stderr = ""
      status = nil
      begin
        Timeout.timeout(timeout_seconds) do
          stdout, stderr, status = Open3.capture3(*cmd)
        end
      rescue Timeout::Error
        raise ConversionError, "point cloud conversion timed out after #{(timeout_seconds / 60.0).round} minutes"
      end
      return if status&.success?

      raise ConversionError, "pdal translate exited with #{status&.exitstatus}: #{(stderr.presence || stdout).to_s.strip[0, 500]}"
    end

    def pdal_bin
      return @pdal_bin if defined?(@pdal_bin)

      candidates = [ENV["PDAL_BIN"], "/usr/bin/pdal", "/usr/local/bin/pdal"].compact
      @pdal_bin = candidates.find { |c| File.executable?(c) } || from_path
    end

    def from_path
      out, status = Open3.capture2e("which", "pdal")
      status.success? ? out.strip.presence : nil
    rescue StandardError
      nil
    end

    def timeout_seconds
      Integer(ENV.fetch("SPATIAL_VIEWER_CONVERT_TIMEOUT", DEFAULT_TIMEOUT_SECONDS.to_s))
    rescue ArgumentError
      DEFAULT_TIMEOUT_SECONDS
    end
  end
end
