# frozen_string_literal: true

require "open3"
require "timeout"
require "tmpdir"
require "fileutils"

module SpatialViewer
  # Builds the multi-resolution octree (hierarchy.json + one .bin per node) the
  # viewer's level-of-detail point renderer streams from, using
  # bin/build_point_octree.js. The source is always a LAS file: the layer's own
  # upload for .las, or the PDAL-converted file for .laz / .e57.
  class PointOctreeBuilder
    class BuildError < StandardError; end

    DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60
    SCRIPT = File.expand_path("../../../bin/build_point_octree.js", __dir__)

    def initialize(layer)
      @layer = layer
    end

    def call
      source = las_source
      raise BuildError, "No LAS source available for this layer" unless source && File.file?(source)

      node = node_bin
      raise BuildError, "Node.js not found (set NODE_BIN)" unless node
      raise BuildError, "bin/build_point_octree.js is missing from the plugin" unless File.file?(SCRIPT)

      FileUtils.mkdir_p(@layer.conversion_dir)
      Dir.mktmpdir("octree", @layer.conversion_dir.to_s) do |tmp|
        out = File.join(tmp, "out")
        run!(node, source, out)
        raise BuildError, "octree build produced no hierarchy" unless File.file?(File.join(out, "hierarchy.json"))

        final = @layer.octree_dir.to_s
        FileUtils.rm_rf(final)
        FileUtils.mv(out, final)
      end

      info = JSON.parse(File.read(@layer.octree_dir.join("hierarchy.json")))
      @layer.update_octree_state(
        status: "completed", attachment_id: @layer.file_attachment&.id, message: nil,
        points: info["count"], nodes: info["nodes"].size
      )
      true
    rescue BuildError => e
      @layer&.update_octree_state(status: "error", attachment_id: @layer.file_attachment&.id, message: e.message)
      raise
    end

    private

    # .las is used straight from the upload; laz/e57 from the PDAL output.
    def las_source
      if @layer.source_format == "las"
        @layer.file_attachment&.diskfile&.path
      elsif @layer.converted_file_ready?
        @layer.converted_file_path.to_s
      end
    end

    def run!(node, input, output)
      stdout = stderr = ""
      status = nil
      begin
        Timeout.timeout(timeout_seconds) do
          stdout, stderr, status = Open3.capture3(node, SCRIPT, input.to_s, output)
        end
      rescue Timeout::Error
        raise BuildError, "octree build timed out after #{(timeout_seconds / 60.0).round} minutes"
      end
      return if status&.success?

      raise BuildError, "octree build exited with #{status&.exitstatus}: #{(stderr.presence || stdout).to_s.strip[-500..]}"
    end

    def node_bin
      candidates = [ENV["NODE_BIN"], "/opt/openproject/.heroku/node/bin/node", "/usr/bin/node", "/usr/local/bin/node"].compact
      candidates.find { |c| File.executable?(c) } || begin
        out, status = Open3.capture2e("which", "node")
        status.success? ? out.strip.presence : nil
      rescue StandardError
        nil
      end
    end

    def timeout_seconds
      Integer(ENV.fetch("SPATIAL_VIEWER_OCTREE_TIMEOUT", DEFAULT_TIMEOUT_SECONDS.to_s))
    rescue ArgumentError
      DEFAULT_TIMEOUT_SECONDS
    end
  end
end
