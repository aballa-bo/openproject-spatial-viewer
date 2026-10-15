# frozen_string_literal: true

class SpatialLayersController < ApplicationController
  before_action :find_project_by_project_id
  before_action :authorize
  before_action :find_model
  before_action :find_layer, only: %i[update destroy file]
  before_action :relax_csp_for_3d_viewer, only: :file

  # Direct files can carry blob:/data: (glTF textures); see SpatialModelsController.
  layout false

  LAYER_CONTENT_TYPES = {
    "glb" => "model/gltf-binary",
    "gltf" => "model/gltf+json",
    "obj" => "application/octet-stream",
    "zip" => "application/zip",
    "ply" => "application/octet-stream",
    "splat" => "application/octet-stream",
    "sog" => "application/octet-stream",
    "las" => "application/octet-stream",
    "laz" => "application/octet-stream",
    "e57" => "application/octet-stream",
    "ifc" => "application/octet-stream"
  }.freeze

  def create
    unless User.current.allowed_in_project?(:manage_spatial_models, @project)
      return render json: { success: false, errors: ["Not allowed"] }, status: :forbidden
    end

    file = params[:file]
    return render json: { success: false, errors: ["No file"] }, status: :unprocessable_entity if file.blank?

    format = SpatialLayer.format_from_filename(file.original_filename)
    unless format
      return render json: { success: false, errors: ["Unsupported file type: #{file.original_filename}"] },
                    status: :unprocessable_entity
    end

    kind = params[:kind].presence_in(SpatialLayer::KINDS) || SpatialLayer.kind_for(format)
    title = params[:title].presence || File.basename(file.original_filename.to_s, ".*")

    layer = @spatial_model.spatial_layers.new(
      title:, kind:, source_format: format,
      uploader: User.current,
      position: (@spatial_model.spatial_layers.maximum(:position) || -1) + 1
    )

    if layer.save
      attachment = Attachment.new(container: layer, author: User.current, file:, description: title)
      if attachment.save
        layer.reload.enqueue_conversion(force: true)
        render json: { success: true, layer: layer_payload(layer), warning: conversion_warning(layer) }, status: :created
      else
        layer.destroy
        render json: { success: false, errors: attachment.errors.full_messages }, status: :unprocessable_entity
      end
    else
      render json: { success: false, errors: layer.errors.full_messages }, status: :unprocessable_entity
    end
  end

  # Tell the user right away if the tool this layer needs is missing, instead of
  # only surfacing it once the background job has failed.
  def conversion_warning(layer)
    return nil unless layer.needs_conversion?

    case layer.source_format
    when "ifc"
      unless ::SpatialViewer::IfcConverter.ifcconvert_available?
        "IfcConvert is not available on the server — this IFC layer cannot be converted to a viewable model."
      end
    when "laz", "e57"
      unless ::SpatialViewer::PointCloudConverter.pdal_available?
        "PDAL is not installed on the server, so this .#{layer.source_format} cannot be converted. " \
        "Ask an administrator to install it (apt-get install pdal), or upload the point cloud as .las or .ply instead."
      end
    end
  end

  def update
    unless User.current.allowed_in_project?(:manage_spatial_models, @project)
      return render json: { success: false, errors: ["Not allowed"] }, status: :forbidden
    end

    attrs = params.require(:spatial_layer).permit(:title, :visible, :position)
    if @layer.update(attrs)
      render json: { success: true, layer: layer_payload(@layer) }
    else
      render json: { success: false, errors: @layer.errors.full_messages }, status: :unprocessable_entity
    end
  end

  def destroy
    unless User.current.allowed_in_project?(:manage_spatial_models, @project)
      return render json: { success: false, errors: ["Not allowed"] }, status: :forbidden
    end

    @layer.destroy
    render json: { success: true }
  end

  def file
    if @layer.needs_conversion?
      return serve_converted
    end

    serve_raw
  end

  # Shared with SpatialModelsController via the same helper name — built here
  # too so the layer file endpoint gets the blob:/data: connect-src it needs.
  def relax_csp_for_3d_viewer
    append_content_security_policy_directives(connect_src: %w[blob: data:])
  end

  private

  def find_model
    @spatial_model = SpatialModel.find_by!(id: params[:spatial_model_id], project: @project)
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  def find_layer
    @layer = @spatial_model.spatial_layers.find(params[:id])
  rescue ActiveRecord::RecordNotFound
    render_404
  end

  def serve_raw
    attachment = @layer.file_attachment
    if attachment && File.exist?(attachment.diskfile.path)
      zip = File.extname(attachment.filename.to_s).casecmp(".zip").zero?
      type = zip ? "application/zip" : (LAYER_CONTENT_TYPES[@layer.source_format] || "application/octet-stream")
      send_file attachment.diskfile.path, filename: attachment.filename, type:, disposition: "inline"
    else
      render_404
    end
  end

  def serve_converted
    if @layer.converted_file_ready?
      send_file @layer.converted_file_path.to_s,
                filename: "layer-#{@layer.id}.#{@layer.viewer_format}",
                type: LAYER_CONTENT_TYPES[@layer.viewer_format] || "application/octet-stream",
                disposition: "inline"
    else
      @layer.enqueue_conversion
      state = @layer.conversion_state
      render json: { status: state["status"].presence || "pending", message: state["message"] }
    end
  end

  def layer_payload(layer)
    {
      id: layer.id,
      title: layer.title,
      kind: layer.kind,
      source_format: layer.source_format,
      format: layer.viewer_format,
      visible: layer.visible,
      url: file_project_spatial_model_spatial_layer_path(@project, @spatial_model, layer),
      conversion: layer.conversion_payload,
      file_size: (layer.needs_conversion? && layer.converted_file_ready? ? layer.converted_file_path.size : layer.file_attachment&.filesize)
    }
  end
end
