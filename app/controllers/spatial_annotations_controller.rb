# frozen_string_literal: true

class SpatialAnnotationsController < ApplicationController
  before_action :find_project_by_project_id
  before_action :authorize
  before_action :find_model
  before_action :find_annotation, only: %i[update destroy snapshot]

  protect_from_forgery with: :null_session, if: -> { request.format.json? }

  def index
    @annotations = @spatial_model.spatial_annotations
                                 .includes(:work_package, :author, :attachments)
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
    @annotation.assign_attributes(annotation_attributes)
    if (wp = resolve_work_package(required: false))
      @annotation.work_package = wp
    end
    @annotation.snapshot = snapshot_param if snapshot_param

    if @annotation.save
      render json: { success: true, annotation: @annotation.as_json_payload }
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

    type = @project.types.where(is_default: true).first || @project.types.order(:position).first

    call = ::WorkPackages::CreateService.new(user: User.current).call(
      project: @project,
      type:,
      subject: subject.to_s.truncate(255),
      description: params[:wp_description].presence
    )

    if call.success?
      call.result
    else
      @work_package_error = call.errors.full_messages.join(", ")
      nil
    end
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
