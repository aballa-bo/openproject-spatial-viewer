# frozen_string_literal: true

module SpatialViewer
  # Mirrors a SpatialAnnotation into the BIM module's BCF structure so it shows
  # up in the "BCF" section of the linked Work Package:
  #
  #   annotation.work_package  ->  Bim::Bcf::Issue (find_or_create, 1:1 with the WP)
  #   annotation               ->  Bim::Bcf::Viewpoint (keyed by viewpoint_uuid)
  #   annotation.snapshot      ->  viewpoint "snapshot" attachment
  #
  # No-ops when the BIM module is not available. Runs as the system user so the
  # mirror does not depend on the annotator holding :manage_bcf.
  class AnnotationBcfSync
    def initialize(annotation)
      @annotation = annotation
    end

    def bim_available?
      defined?(::Bim::Bcf::Issue) && defined?(::Bim::Bcf::Viewpoint)
    end

    def call
      return unless bim_available?
      return unless @annotation.work_package

      User.system.run_given do
        issue = find_or_create_issue(@annotation.work_package)
        set_column(:bcf_issue_id, issue.id)

        viewpoint = issue.viewpoints.find_by(uuid: @annotation.viewpoint_uuid) ||
                    issue.viewpoints.new(uuid: @annotation.viewpoint_uuid)
        viewpoint.viewpoint_name = @annotation.title
        viewpoint.json_viewpoint = @annotation.to_bcf_viewpoint_json
        viewpoint.save!
        set_column(:bcf_viewpoint_id, viewpoint.id)

        copy_snapshot(viewpoint)
        viewpoint
      end
    end

    def destroy_viewpoint
      return unless bim_available?
      return unless @annotation.bcf_viewpoint_id

      User.system.run_given do
        viewpoint = ::Bim::Bcf::Viewpoint.find_by(id: @annotation.bcf_viewpoint_id)
        next unless viewpoint

        issue = viewpoint.issue
        viewpoint.destroy

        # Drop the BCF topic too if nothing else references it, so we don't
        # leave an empty topic on the Work Package.
        if issue && issue.reload.viewpoints.empty? && issue.comments.empty?
          issue.destroy
        end
      end
    end

    private

    def find_or_create_issue(work_package)
      ::Bim::Bcf::Issue.find_or_create_by!(work_package:)
    rescue ActiveRecord::RecordNotUnique
      ::Bim::Bcf::Issue.find_by!(work_package:)
    end

    def copy_snapshot(viewpoint)
      snap = @annotation.snapshot
      return unless snap&.diskfile && File.exist?(snap.diskfile.path)

      existing = viewpoint.snapshot
      return if existing && existing.digest.present? && existing.digest == snap.digest

      existing&.destroy

      file = File.open(snap.diskfile.path)
      file.define_singleton_method(:original_filename) { "snapshot.png" }
      ::Attachments::BuildService
        .bypass_allowlist(user: User.current)
        .call(file:, container: viewpoint, filename: "snapshot.png", description: "snapshot")
    ensure
      file&.close
    end

    def set_column(name, value)
      return if @annotation.public_send(name) == value

      @annotation.update_column(name, value) # rubocop:disable Rails/SkipsModelValidations
    end
  end
end
