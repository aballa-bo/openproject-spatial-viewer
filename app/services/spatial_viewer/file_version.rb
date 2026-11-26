# frozen_string_literal: true

module SpatialViewer
  # Version token of the file a model/layer endpoint actually serves (the
  # uploaded attachment, or its server-side conversion). It changes whenever
  # that file changes, so the viewer can keep a downloaded layer in the
  # browser and fetch it again only when the token differs.
  module FileVersion
    module_function

    # record: SpatialModel or SpatialLayer (both expose model_attachment,
    # needs_conversion?, converted_file_ready?, converted_file_path).
    def for(record)
      attachment = record.model_attachment
      return nil if attachment.blank?

      parts = ["a#{attachment.id}", attachment.digest.presence || attachment.filesize.to_s]
      if record.needs_conversion?
        return nil unless record.converted_file_ready?

        stat = File.stat(record.converted_file_path.to_s)
        parts << "c#{stat.size}-#{stat.mtime.to_i}"
      end
      Digest::SHA256.hexdigest(parts.join("|"))[0, 20]
    rescue StandardError
      nil
    end
  end
end
