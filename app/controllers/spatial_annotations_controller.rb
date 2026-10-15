# frozen_string_literal: true

class SpatialAnnotationsController < ApplicationController
  before_action :find_project_by_project_id
  before_action :authorize
  before_action :find_model
  before_action :find_annotation, only: %i[update destroy snapshot]

  protect_from_forgery with: :null_session, if: -> { request.format.json? }

  def index
    @annotations = @spatial_model.spatial_annotations
                                 .includes(:work_package, :author, :attachments, spatial_model: :project)
                                 .order(created_at: :desc)
    render json: @annotations.map(&:as_json_payload)
  end

  def create
    work_package = resolve_work_package
    if work_package.nil?
      return render json: { success: false, errors: [@work_package_error || "A Work Package is required"] },
                    status: :unprocessable_entity
    end

    @annotation = @spatial_model.spatial_annotations.new(annotation_attributes)
    @annotation.author = User.current
    @annotation.work_package = work_package
    @annotation.snapshot = snapshot_param if snapshot_param

    if @annotation.save
      render json: { success: true, annotation: @annotation.as_json_payload }, status: :created
    else
      render json: { success: false, errors: @annotation.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def update
    @annotation.assign_attributes(annotation_attributes) if params[:spatial_annotation].present?
    if (wp = resolve_work_package(required: false))
      @annotation.work_package = wp
    end
    @annotation.snapshot = snapshot_param if snapshot_param

    if params[:work_package].present?
      wp_error = update_linked_work_package
      if wp_error
        return render json: { success: false, errors: [wp_error] }, status: :unprocessable_entity
      end
    end

    saved = @annotation.changed? ? @annotation.save : true
    if saved
      render json: { success: true, annotation: @annotation.reload.as_json_payload }
    else
      render json: { success: false, errors: @annotation.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    @annotation.destroy
    render json: { success: true }
  end

  def snapshot
    attachment = @annotation.snapshot
    if attachment&.diskfile && File.exist?(attachment.diskfile.path)
      send_file attachment.diskfile.path,
                filename: attachment.filename,
                type: attachment.content_type.presence || "image/png",
                disposition: "inline"
    else
      render_404
    end
  end

  private

  def find_model
    @spatial_model = SpatialModel.find_by!(id: params[:spatial_model_id], project: @project)
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  def find_annotation
    @annotation = @spatial_model.spatial_annotations.find(params[:id])
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  # Every annotation is tied to a Work Package: link the one given, or create a
  # new one (BCF-style: the annotation's "topic").
  def resolve_work_package(required: true)
    wp_id = params.dig(:spatial_annotation, :work_package_id).presence || params[:work_package_id].presence

    if wp_id
      wp = @project.work_packages.visible.find_by(id: wp_id)
      @work_package_error = "The selected Work Package was not found" if wp.nil?
      return wp
    end

    return nil unless required || params[:create_work_package].to_s == "true"

    create_work_package
  end

  def create_work_package
    subject = params[:wp_subject].presence ||
              params.dig(:spatial_annotation, :title).presence ||
              "3D annotation"

    type = @project.types.find_by(id: params[:wp_type_id]) ||
           @project.types.where(is_default: true).first ||
           @project.types.order(:position).first

    attributes = {
      project: @project,
      type:,
      subject: subject.to_s.truncate(255),
      description: params[:wp_description].presence
    }
    # The inline panel offers the full standard work package field set, just
    # like the BCF module. Every attribute is optional — pass through only the
    # ones the user actually filled in and let the create contract validate.
    {
      assigned_to_id: :wp_assigned_to_id,
      responsible_id: :wp_responsible_id,
      status_id:      :wp_status_id,
      priority_id:    :wp_priority_id,
      category_id:    :wp_category_id,
      version_id:     :wp_version_id,
      parent_id:      :wp_parent_id,
      start_date:     :wp_start_date,
      due_date:       :wp_due_date,
      estimated_hours: :wp_estimated_hours
    }.each do |attr, param|
      attributes[attr] = params[param] if params[param].present?
    end

    # Custom fields are type/project-specific (see SpatialModelsController#show,
    # @custom_fields_by_type) -- the client only ever renders/sends the ones
    # actually enabled for the selected type, so this is passed straight
    # through to the same custom_field_values= setter the native work
    # package form uses (ActsAsCustomizable; accepts either a scalar or an
    # array per custom field id, covering single- and multi-value fields).
    cfv = params[:wp_custom_field_values]
    # ActionController::Parameters has no #any? (only #empty?/#keys/#include?
    # etc. are delegated to the underlying hash) -- calling it raised
    # NoMethodError, a 500 with an HTML body, which is why this failed with
    # "Unexpected token '<' ... is not valid JSON" on the client instead of
    # a normal JSON error response.
    attributes[:custom_field_values] = cfv.to_unsafe_h if cfv.is_a?(ActionController::Parameters) && !cfv.empty?

    call = ::WorkPackages::CreateService.new(user: User.current).call(**attributes)

    if call.success?
      call.result
    else
      @work_package_error = call.errors.full_messages.join(", ")
      nil
    end
  end

  # Edit the Work Package linked to the annotation, from the detail panel.
  # Returns an error string on failure, nil on success.
  def update_linked_work_package
    wp = @annotation.work_package
    return "This annotation has no linked Work Package" unless wp

    permitted = params.require(:work_package).permit(
      :subject, :description, :type_id, :status_id, :assigned_to_id, :responsible_id,
      :priority_id, :category_id, :version_id, :parent_id, :start_date, :due_date, :estimated_hours
    )
    # Blank string means "clear this field"; drop keys the client did not send.
    attrs = permitted.to_h.symbolize_keys.transform_values { |v| v == "" ? nil : v }

    # Custom fields are a dynamic, type-specific set (see
    # SpatialModelsController#show, @custom_fields_by_type) -- read directly
    # rather than through the fixed `permit` list above, same as
    # create_work_package's wp_custom_field_values. Passed straight through
    # to the custom_field_values= setter the native work package form uses
    # (ActsAsCustomizable); "" still means "clear this field" here too, same
    # as every other attribute, and an empty array for a multi-value field
    # already means that on its own (Array(nil) == Array("") == []).
    cfv = params.dig(:work_package, :custom_field_values)
    # ActionController::Parameters has no #any? -- see create_work_package's
    # matching comment.
    if cfv.is_a?(ActionController::Parameters) && !cfv.empty?
      attrs[:custom_field_values] = cfv.to_unsafe_h.transform_values { |v| v == "" ? nil : v }
    end
    return nil if attrs.empty?

    call = ::WorkPackages::UpdateService.new(user: User.current, model: wp).call(**attrs)
    call.success? ? nil : call.errors.full_messages.join(", ")
  end

  def annotation_attributes
    annotation_params.except(:work_package_id, :thumbnail_base64).to_h.tap do |attrs|
      attrs[:camera_viewpoint] = attrs[:camera_viewpoint].to_h if attrs[:camera_viewpoint].respond_to?(:to_h)
      attrs[:geometry_data]    = attrs[:geometry_data].to_h if attrs[:geometry_data].respond_to?(:to_h)
    end
  end

  def snapshot_param
    params.dig(:spatial_annotation, :thumbnail_base64).presence
  end

  def annotation_params
    params.require(:spatial_annotation).permit(
      :title,
      :description,
      :annotation_type,
      :color,
      :work_package_id,
      :thumbnail_base64,
      camera_viewpoint: {},
      geometry_data: {}
    )
  end
end
