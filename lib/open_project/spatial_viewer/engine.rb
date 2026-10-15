# frozen_string_literal: true
require 'open_project/plugins'

module OpenProject
  module SpatialViewer
    class Engine < ::Rails::Engine
      engine_name :openproject_spatial_viewer

      include OpenProject::Plugins::ActsAsOpEngine

      register 'openproject-spatial_viewer',
               author_url: 'https://www.openproject.org',
               bundled: true do

        project_module :spatial_viewer do
          permission :view_spatial_models,
                     { spatial_models: %i[index show api_data model_file download_exe],
                       spatial_layers: %i[file],
                       spatial_annotations: %i[index snapshot] },
                     permissible_on: :project,
                     public: true

          permission :manage_spatial_models,
                     { spatial_models: %i[new create edit update destroy set_start_view],
                       spatial_layers: %i[create update destroy] },
                     permissible_on: :project,
                     require: :member

          permission :create_spatial_annotations,
                     { spatial_annotations: %i[create update destroy] },
                     permissible_on: :project,
                     require: :loggedin
        end

        menu :project_menu,
             :spatial_models,
             { controller: '/spatial_models', action: 'index' },
             caption: ->(project) { I18n.t('spatial_viewer.label_3d_viewer', default: '3D & Splatting') },
             icon: 'op-view-threed',
             after: :bim
      end

      initializer 'spatial_viewer.register_assets' do |app|
        app.config.assets.paths << root.join('app/assets/stylesheets')
        app.config.assets.paths << root.join('app/assets/javascripts')
      end

      config.to_prepare do
        require 'open_project/spatial_viewer/hooks'
        Project.include OpenProject::SpatialViewer::Patches::ProjectPatch unless Project.included_modules.include?(OpenProject::SpatialViewer::Patches::ProjectPatch)
        Attachment.include OpenProject::SpatialViewer::Patches::AttachmentPatch unless Attachment.included_modules.include?(OpenProject::SpatialViewer::Patches::AttachmentPatch)
      end
    end
  end
end
