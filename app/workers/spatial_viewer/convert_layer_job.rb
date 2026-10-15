# frozen_string_literal: true

module SpatialViewer
  # Background conversion of a SpatialLayer:
  #   ifc        -> glb  (IfcConvert)
  #   laz / e57  -> las  (pdal translate)
  #
  # Duplicate enqueues are guarded by SpatialLayer#enqueue_conversion.
  class ConvertLayerJob < ::ApplicationJob
    queue_as :spatial_viewer_conversion

    def perform(layer_id)
      layer = SpatialLayer.find_by(id: layer_id)
      return unless layer&.needs_conversion?
      return unless layer.file_attachment
      return if layer.converted_file_ready?

      layer.update_conversion_state(
        status: "processing",
        attachment_id: layer.file_attachment.id,
        message: nil,
        started_at: Time.current
      )

      case layer.source_format
      when "ifc"
        ::SpatialViewer::IfcConverter.new(layer).call
      when "laz", "e57"
        ::SpatialViewer::PointCloudConverter.new(layer).call
      end
    rescue ::SpatialViewer::IfcConverter::ConversionError,
           ::SpatialViewer::PointCloudConverter::ConversionError => e
      Rails.logger.warn("[SpatialViewer] SpatialLayer ##{layer_id} conversion failed: #{e.message}")
    rescue StandardError => e
      Rails.logger.error("[SpatialViewer] SpatialLayer ##{layer_id} conversion crashed: #{e.message}")
      SpatialLayer.find_by(id: layer_id)&.update_conversion_state(status: "error", message: e.message)
    end
  end
end
