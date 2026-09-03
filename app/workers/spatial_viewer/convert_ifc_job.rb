# frozen_string_literal: true

module SpatialViewer
  # Background conversion of an IFC SpatialModel to a cached .glb file.
  #
  # Duplicate enqueues are guarded by SpatialModel#enqueue_conversion, which
  # only schedules a job when one is not already pending/processing for the
  # current attachment.
  class ConvertIfcJob < ::ApplicationJob
    queue_as :spatial_viewer_conversion

    def perform(spatial_model_id)
      model = SpatialModel.find_by(id: spatial_model_id)
      return unless model&.needs_conversion?
      return unless model.model_attachment
      return if model.converted_file_ready?

      model.update_conversion_state(
        status: "processing",
        attachment_id: model.model_attachment.id,
        message: nil,
        started_at: Time.current
      )

      ::SpatialViewer::IfcConverter.new(model).call
    rescue ::SpatialViewer::IfcConverter::ConversionError => e
      # State already recorded by the converter; just log.
      Rails.logger.warn("[SpatialViewer] IFC conversion failed for SpatialModel ##{spatial_model_id}: #{e.message}")
    rescue StandardError => e
      Rails.logger.error("[SpatialViewer] IFC conversion crashed for SpatialModel ##{spatial_model_id}: #{e.message}")
      SpatialModel.find_by(id: spatial_model_id)&.update_conversion_state(status: "error", message: e.message)
    end
  end
end
