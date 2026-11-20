import bpy, sys
source, output = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=source, use_image_search=True)
missing = [i.name for i in bpy.data.images if i.source == 'FILE' and not i.has_data]
if missing:
    print('Warning: missing textures: ' + ', '.join(missing))
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', export_animations=True, export_all_influences=True)
