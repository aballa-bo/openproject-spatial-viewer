# frozen_string_literal: true
require 'open_project/hook'

module OpenProject
  module SpatialViewer
    class Hooks < ::OpenProject::Hook::ViewListener
      def view_layouts_base_html_head(context = {})
        controller = context[:controller]
        return '' unless controller
        return '' unless controller.is_a?(::SpatialModelsController) ||
                         controller.is_a?(::SpatialAnnotationsController)

        stylesheet = controller.view_context.stylesheet_link_tag('/assets/openproject_spatial_viewer/viewer.css')
        vendor_js = controller.view_context.nonced_javascript_include_tag('/assets/openproject_spatial_viewer/vendor.bundle.js', skip_pipeline: true)
        engine_js = controller.view_context.nonced_javascript_include_tag('/assets/openproject_spatial_viewer/viewer_engine.js', skip_pipeline: true)

        "#{stylesheet}\n#{vendor_js}\n#{engine_js}".html_safe
      end
    end
  end
end
