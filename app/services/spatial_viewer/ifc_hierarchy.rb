# frozen_string_literal: true

require "json"
require "open3"
require "timeout"
require "fileutils"

module SpatialViewer
  # Spatial/element hierarchy of an IFC layer (Project > Site > Building >
  # Storey > elements), read with the `xeokit-metadata` tool that ships with
  # OpenProject's BIM module. Cached next to the converted file, per attachment.
  #
  # Element ids are returned as the UUID form of the IFC GlobalId, which is how
  # IfcConvert names the glTF nodes ("product-<uuid>-body"), so the viewer can
  # match tree entries to meshes.
  class IfcHierarchy
    class Error < StandardError; end

    ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"
    TIMEOUT_SECONDS = 5 * 60

    def initialize(layer)
      @layer = layer
    end

    # IFC compressed GlobalId (22 chars) -> "8-4-4-4-12" UUID.
    def self.guid_to_uuid(guid)
      n = guid.to_s.each_char.reduce(0) { |acc, c| (acc * 64) + (ALPHABET.index(c) || 0) }
      h = format("%032x", n)
      "#{h[0, 8]}-#{h[8, 4]}-#{h[12, 4]}-#{h[16, 4]}-#{h[20, 12]}"
    end

    def self.available?
      !new(nil).send(:bin).nil?
    end

    # Array of { id:, guid:, name:, type:, parent: } (parent = uuid or nil).
    def call
      attachment = @layer.file_attachment
      raise Error, "No IFC file attached" unless attachment

      cache = @layer.conversion_dir.join("hierarchy-#{attachment.id}.json")
      return JSON.parse(cache.read) if cache.file? && cache.size.to_i.positive?

      source = attachment.diskfile&.path
      raise Error, "IFC file not found on disk" unless source && File.file?(source)
      raise Error, "xeokit-metadata not found" unless bin

      FileUtils.mkdir_p(cache.dirname)
      tmp = "#{cache}.#{Process.pid}.tmp"
      begin
        _out, err, status = Timeout.timeout(TIMEOUT_SECONDS) { Open3.capture3(bin, File.expand_path(source), tmp) }
        raise Error, "xeokit-metadata failed: #{err.to_s.strip[0, 300]}" unless status.success? && File.file?(tmp)

        objects = JSON.parse(File.read(tmp)).fetch("metaObjects", [])
      rescue Timeout::Error
        raise Error, "Reading the IFC hierarchy timed out"
      ensure
        FileUtils.rm_f(tmp)
      end

      list = objects.map do |o|
        { id: self.class.guid_to_uuid(o["id"]), guid: o["id"], name: o["name"].to_s, type: o["type"].to_s,
          parent: o["parent"].present? ? self.class.guid_to_uuid(o["parent"]) : nil }
      end
      cache.write(JSON.generate(list))
      JSON.parse(JSON.generate(list))
    end

    private

    def bin
      return @bin if defined?(@bin)

      @bin = [ENV["XEOKIT_METADATA_BIN"], Rails.root.join("bin/xeokit-metadata").to_s,
              "/opt/openproject/bin/xeokit-metadata"].compact.find { |c| File.executable?(c) }
    end
  end
end
