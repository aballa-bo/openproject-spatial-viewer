# frozen_string_literal: true

# Conditional GET for model/layer files. OpenProject marks every response
# "max-age=0, must-revalidate", so without validators the browser downloads
# a whole layer (often hundreds of MB) on every page view.
#
# * ETag = SpatialViewer::FileVersion: an unchanged file is answered with
#   "304 Not Modified" and no body.
# * URLs that carry the current version (?v=<token>, see the layers payload)
#   never change content, so they may be cached for a year (immutable).
module SpatialViewerCachedFiles
  extend ActiveSupport::Concern

  private

  # Returns true when a 304 was sent (the caller must not send the file).
  def spatial_file_not_modified?(record, path)
    version = ::SpatialViewer::FileVersion.for(record)
    return false if version.blank?

    expires_in 1.year, public: false, immutable: true if params[:v].to_s == version
    !stale?(etag: version, last_modified: File.mtime(path.to_s).utc, public: false)
  rescue StandardError => e
    Rails.logger.warn("[spatial_viewer] cache validators skipped: #{e.class}: #{e.message}")
    false
  end

  def spatial_file_version(record)
    ::SpatialViewer::FileVersion.for(record)
  end
end
