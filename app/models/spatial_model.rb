# frozen_string_literal: true

class SpatialModel < ApplicationRecord
  acts_as_attachable view_permission: :view_spatial_models,
                     add_permission: :manage_spatial_models,
                     delete_permission: :manage_spatial_models

  belongs_to :project
  belongs_to :uploader, class_name: "User"
  has_many :spatial_annotations, dependent: :destroy
  has_many :spatial_share_links, dependent: :destroy
  has_many :spatial_layers, -> { ordered }, dependent: :destroy, inverse_of: :spatial_model

  validates :title, presence: true
  validates :project, presence: true
  validates :uploader, presence: true
  validates :model_format, inclusion: { in: %w[gltf glb obj gaussian_splat ply splat ksplat sog ifc] }

  validates :latitude, numericality: { greater_than_or_equal_to: -90, less_than_or_equal_to: 90 }, allow_nil: true
  validates :longitude, numericality: { greater_than_or_equal_to: -180, less_than_or_equal_to: 180 }, allow_nil: true
  validate :location_is_complete

  scope :defaults, -> { where(is_default: true) }

  # Formats that cannot be rendered directly by the WebGL viewer and are
  # converted server-side to .glb first.
  CONVERTIBLE_FORMATS = %w[ifc].freeze

  after_destroy :cleanup_converted_files

  # The most recently uploaded file. `attachments` is ordered by created_at
  # ascending, so `.first` would return a stale file that is still hanging
  # around after a re-upload (e.g. a broken multi-file .gltf replaced by a
  # self-contained .glb).
  def model_attachment
    attachments.to_a.max_by { |a| [a.created_at, a.id] }
  end

  def model_attachment_url
    if model_attachment.present?
      "/api/v3/attachments/#{model_attachment.id}/content"
    end
  end

  # Formats to show in lists: layers' source formats, plus the legacy primary
  # file's format for models created before files were uploaded as layers.
  def layer_formats
    fmts = spatial_layers.map(&:source_format)
    fmts.unshift(model_format) if model_attachment.present?
    fmts.compact.uniq
  end

  def formatted_size
    if model_attachment.present?
      "#{(model_attachment.filesize.to_f / 1024 / 1024).round(2)} MB"
    else
      "N/A"
    end
  end

  # ---- Server-side conversion (IFC -> GLB) --------------------------------

  # Format the front-end viewer should actually load.
  def viewer_format
    needs_conversion? ? "glb" : model_format
  end

  def needs_conversion?
    CONVERTIBLE_FORMATS.include?(model_format)
  end

  def self.conversion_storage_root
    base = begin
      OpenProject::Configuration.attachments_storage_path
    rescue StandardError
      Rails.root.join("files")
    end
    Pathname(base.to_s).join("spatial_viewer")
  end

  def conversion_dir
    self.class.conversion_storage_root.join(id.to_s)
  end

  def converted_file_path
    conversion_dir.join("model.glb")
  end

  def conversion_state
    (settings || {}).fetch("conversion", {}) || {}
  end

  # Camera position + orbit target the viewer opens with, set via the
  # "Navigate" menu's "Set as start view" action. nil means "auto fit to view".
  def start_view
    (settings || {})["start_view"]
  end

  def set_start_view(position:, target:)
    merged = (settings || {}).merge(
      "start_view" => { "position" => vec3_attrs(position), "target" => vec3_attrs(target) }
    )
    update_column(:settings, merged) # rubocop:disable Rails/SkipsModelValidations
  end

  def clear_start_view
    merged = (settings || {}).except("start_view")
    update_column(:settings, merged) # rubocop:disable Rails/SkipsModelValidations
  end

  def location?
    latitude.present? && longitude.present?
  end

  SAVED_VIEW_SLOTS = 4
  MAX_VIEW_THUMBNAIL_BYTES = 120_000

  # Up to four named camera views (slots 1..4), each with a small JPEG
  # thumbnail (data URL). Array of SAVED_VIEW_SLOTS entries, nil = empty slot.
  def saved_views
    list = (settings || {})["saved_views"]
    list = [] unless list.is_a?(Array)
    Array.new(SAVED_VIEW_SLOTS) { |i| list[i].is_a?(Hash) ? list[i] : nil }
  end

  def set_saved_view(slot:, position:, target:, thumbnail:)
    views = saved_views
    views[slot - 1] = {
      "position" => vec3_attrs(position), "target" => vec3_attrs(target), "thumbnail" => thumbnail
    }
    update_column(:settings, (settings || {}).merge("saved_views" => views)) # rubocop:disable Rails/SkipsModelValidations
  end

  def clear_saved_view(slot)
    views = saved_views
    views[slot - 1] = nil
    update_column(:settings, (settings || {}).merge("saved_views" => views)) # rubocop:disable Rails/SkipsModelValidations
  end

  def converted_file_ready?
    return false unless needs_conversion? && model_attachment.present?

    state = conversion_state
    state["status"] == "completed" &&
      state["attachment_id"] == model_attachment.id &&
      converted_file_path.file? &&
      converted_file_path.size.to_i.positive?
  end

  # Persist conversion progress without touching validations / updated_at races.
  def update_conversion_state(attrs)
    merged = (settings || {}).merge("conversion" => conversion_state.merge(attrs.stringify_keys))
    update_column(:settings, merged) # rubocop:disable Rails/SkipsModelValidations
  end

  # Schedule a conversion job unless the cached file is current or a job is
  # already in flight for this attachment.
  def enqueue_conversion(force: false)
    return unless needs_conversion? && model_attachment.present?
    return if converted_file_ready? && !force

    state = conversion_state
    in_flight = %w[pending processing].include?(state["status"]) &&
                state["attachment_id"] == model_attachment.id &&
                recent_enqueue?(state["enqueued_at"])
    return if in_flight && !force

    update_conversion_state(
      status: "pending",
      attachment_id: model_attachment.id,
      message: nil,
      enqueued_at: Time.current
    )
    ::SpatialViewer::ConvertIfcJob.perform_later(id)
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
    Rails.logger.warn("[SpatialViewer] Could not remove converted files for ##{id}: #{e.message}")
  end

  def location_is_complete
    return if latitude.present? == longitude.present?

    errors.add(:base, "Latitude and longitude must be filled in together")
  end

  def vec3_attrs(h)
    { "x" => h[:x].to_f, "y" => h[:y].to_f, "z" => h[:z].to_f }
  end
end
