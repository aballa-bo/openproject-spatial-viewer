# frozen_string_literal: true

# One file inside a SpatialModel. A model is a stack of layers the user uploads
# separately (IFC, mesh + textures, point cloud, gaussian splatting), all in the
# same coordinate system; the viewer shows/hides them independently.
class SpatialLayer < ApplicationRecord
  acts_as_attachable view_permission: :view_spatial_models,
                     add_permission: :manage_spatial_models,
                     delete_permission: :manage_spatial_models

  belongs_to :spatial_model
  belongs_to :uploader, class_name: "User", optional: true

  KINDS = %w[ifc mesh pointcloud splat].freeze
  FORMATS = %w[ifc obj glb gltf zip ply splat sog las laz e57].freeze

  KIND_BY_FORMAT = {
    "ifc" => "ifc",
    "obj" => "mesh", "glb" => "mesh", "gltf" => "mesh", "zip" => "mesh",
    "ply" => "splat", "splat" => "splat", "sog" => "splat",
    "las" => "pointcloud", "laz" => "pointcloud", "e57" => "pointcloud"
  }.freeze

  # ifc -> glb (IfcConvert), laz/e57 -> las (pdal). Everything else loads as-is.
  CONVERTIBLE_FORMATS = %w[ifc laz e57].freeze

  validates :title, presence: true
  validates :kind, inclusion: { in: KINDS }
  validates :source_format, inclusion: { in: FORMATS }
  validates :spatial_model, presence: true

  scope :ordered, -> { order(:position, :id) }

  after_destroy :cleanup_converted_files

  def self.kind_for(format)
    KIND_BY_FORMAT[format.to_s.downcase] || "mesh"
  end

  def self.format_from_filename(name)
    ext = File.extname(name.to_s).delete(".").downcase
    ext = "gltf" if ext == "gltf"
    return "zip" if ext == "zip"
    FORMATS.include?(ext) ? ext : nil
  end

  def file_attachment
    attachments.to_a.max_by { |a| [a.created_at, a.id] }
  end
  # so SpatialViewer::IfcConverter (written for SpatialModel) works unchanged
  alias_method :model_attachment, :file_attachment

  def formatted_size
    a = file_attachment
    a ? "#{(a.filesize.to_f / 1_048_576).round(2)} MB" : "N/A"
  end

  # ---- server-side conversion ------------------------------------------

  def needs_conversion?
    CONVERTIBLE_FORMATS.include?(source_format)
  end

  # Format the front-end loader should use for the served file.
  def viewer_format
    case source_format
    when "ifc" then "glb"
    when "laz", "e57" then "las"
    else source_format
    end
  end

  def conversion_dir
    SpatialModel.conversion_storage_root.join("layer-#{id}")
  end

  def converted_file_path
    conversion_dir.join("layer.#{viewer_format}")
  end

  def conversion_state
    (settings || {}).fetch("conversion", {}) || {}
  end

  def update_conversion_state(attrs)
    merged = (settings || {}).merge("conversion" => conversion_state.merge(attrs.stringify_keys))
    update_column(:settings, merged) # rubocop:disable Rails/SkipsModelValidations
  end

  def converted_file_ready?
    return false unless needs_conversion? && file_attachment.present?

    state = conversion_state
    state["status"] == "completed" &&
      state["attachment_id"] == file_attachment.id &&
      converted_file_path.file? &&
      converted_file_path.size.to_i.positive?
  end

  def enqueue_conversion(force: false)
    return unless needs_conversion? && file_attachment.present?

    if force
      # Drop the cached output so the job actually re-runs (it early-returns
      # when a converted file is already present).
      FileUtils.rm_rf(conversion_dir.to_s)
    elsif converted_file_ready?
      return
    end

    state = conversion_state
    in_flight = %w[pending processing].include?(state["status"]) &&
                state["attachment_id"] == file_attachment.id &&
                recent_enqueue?(state["enqueued_at"])
    return if in_flight && !force

    update_conversion_state(status: "pending", attachment_id: file_attachment.id,
                            message: nil, enqueued_at: Time.current)
    ::SpatialViewer::ConvertLayerJob.perform_later(id)
  end

  # nil for directly-rendered formats; a { status:, message: } hash otherwise.
  def conversion_payload
    return nil unless needs_conversion?
    return { status: "error", message: "No file attached to this layer." } if file_attachment.blank?

    state = conversion_state
    {
      status: converted_file_ready? ? "completed" : (state["status"].presence || "pending"),
      message: state["message"]
    }
  end

  private

  def recent_enqueue?(timestamp)
    return false if timestamp.blank?

    Time.zone.parse(timestamp.to_s) > 45.minutes.ago
  rescue ArgumentError, TypeError
    false
  end

  def cleanup_converted_files
    FileUtils.rm_rf(conversion_dir.to_s) if id.present?
  rescue StandardError => e
    Rails.logger.warn("[SpatialViewer] Could not remove converted files for SpatialLayer ##{id}: #{e.message}")
  end
end
