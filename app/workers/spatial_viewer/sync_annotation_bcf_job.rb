# frozen_string_literal: true

module SpatialViewer
  # Mirrors a SpatialAnnotation into the BIM module's BCF structure
  # (Bim::Bcf::Issue / Bim::Bcf::Viewpoint) in the background, so the
  # annotation shows up in the "BCF" section of its Work Package.
  class SyncAnnotationBcfJob < ::ApplicationJob
    queue_as :spatial_viewer

    def perform(annotation_id)
      annotation = SpatialAnnotation.find_by(id: annotation_id)
      return unless annotation

      ::SpatialViewer::AnnotationBcfSync.new(annotation).call
    rescue StandardError => e
      Rails.logger.warn("[SpatialViewer] BCF sync job failed for annotation ##{annotation_id}: #{e.message}")
    end
  end
end
