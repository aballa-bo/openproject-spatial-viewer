# frozen_string_literal: true
require 'open_project/hook'
require 'digest/md5'

module OpenProject
  module SpatialViewer
    class Hooks < ::OpenProject::Hook::ViewListener
      # The viewer assets are served as plain static files (skip_pipeline: true),
      # so their URLs carry no Sprockets digest. Nginx serves them with
      # `Cache-Control: max-age=31536000`, which means a browser that has loaded
      # viewer_engine.js once will keep running that copy for a year and never
      # even revalidate — every redeploy is invisible until a hard refresh.
      #
      # Append a content hash as a query string so a changed file gets a new URL.
      JS_DIR = 'app/assets/javascripts/openproject_spatial_viewer'
      CSS_DIR = 'app/assets/stylesheets/openproject_spatial_viewer'

      SOURCE_FILES = {
        '/assets/openproject_spatial_viewer/viewer.css'            => "#{CSS_DIR}/viewer.css",
        '/assets/openproject_spatial_viewer/vendor.bundle.js'      => "#{JS_DIR}/vendor.bundle.js",
        '/assets/openproject_spatial_viewer/vendor/mesh-bvh.js'    => "#{JS_DIR}/vendor/mesh-bvh.js",
        '/assets/openproject_spatial_viewer/viewer_engine.js'      => "#{JS_DIR}/viewer_engine.js",
        '/assets/openproject_spatial_viewer/layer_manager.js'      => "#{JS_DIR}/layer_manager.js"
      }.freeze

      def view_layouts_base_html_head(context = {})
        controller = context[:controller]
        return '' unless controller
        return '' unless controller.is_a?(::SpatialModelsController) ||
                         controller.is_a?(::SpatialAnnotationsController) ||
                         controller.is_a?(::SpatialLayersController)

        vc = controller.view_context
        stylesheet = vc.stylesheet_link_tag(bust('/assets/openproject_spatial_viewer/viewer.css'))
        vendor_js = vc.nonced_javascript_include_tag(bust('/assets/openproject_spatial_viewer/vendor.bundle.js'), skip_pipeline: true)
        bvh_js = vc.nonced_javascript_include_tag(bust('/assets/openproject_spatial_viewer/vendor/mesh-bvh.js'), skip_pipeline: true)
        engine_js = vc.nonced_javascript_include_tag(bust('/assets/openproject_spatial_viewer/viewer_engine.js'), skip_pipeline: true)
        layer_js = vc.nonced_javascript_include_tag(bust('/assets/openproject_spatial_viewer/layer_manager.js'), skip_pipeline: true)

        "#{stylesheet}\n#{vendor_js}\n#{bvh_js}\n#{engine_js}\n#{layer_js}".html_safe
      end

      private

      # Appends ?v=<hash> derived from the file's current contents. Cached per
      # process; a redeploy restarts the workers, so the hash is recomputed then.
      def bust(url)
        token = asset_tokens[url]
        token ? "#{url}?v=#{token}" : url
      end

      def asset_tokens
        @asset_tokens ||= SOURCE_FILES.each_with_object({}) do |(url, rel), acc|
          path = Engine.root.join(rel)
          acc[url] = Digest::MD5.file(path).hexdigest[0, 12] if File.exist?(path)
        rescue StandardError
          # Never let a cache-busting failure take down the page head.
          next
        end
      end
    end
  end
end
