# frozen_string_literal: true

module SpatialViewer
  # Background build of a point-cloud layer's LOD octree (see PointOctreeBuilder).
  # Duplicate enqueues are guarded by SpatialLayer#enqueue_octree.
  class BuildPointOctreeJob < ::ApplicationJob
    queue_as :spatial_viewer_conversion

    def perform(layer_id)
      layer = SpatialLayer.find_by(id: layer_id)
      return unless layer&.octree_applicable? && layer.file_attachment
      return if layer.octree_ready?

      layer.update_octree_state(status: "processing", attachment_id: layer.file_attachment.id,
                                message: nil, started_at: Time.current)
      ::SpatialViewer::PointOctreeBuilder.new(layer).call
    rescue ::SpatialViewer::PointOctreeBuilder::BuildError => e
      Rails.logger.warn("[SpatialViewer] SpatialLayer ##{layer_id} octree build failed: #{e.message}")
    rescue StandardError => e
      Rails.logger.error("[SpatialViewer] SpatialLayer ##{layer_id} octree build crashed: #{e.message}")
      SpatialLayer.find_by(id: layer_id)&.update_octree_state(status: "error", message: e.message)
    end
  end
end
