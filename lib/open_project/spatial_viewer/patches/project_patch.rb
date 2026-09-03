# frozen_string_literal: true

module OpenProject
  module SpatialViewer
    module Patches
      module ProjectPatch
        extend ActiveSupport::Concern

        included do
          has_many :spatial_models, class_name: 'SpatialModel', dependent: :destroy
        end
      end
    end
  end
end
