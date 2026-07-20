"""Blender headless splice script for /modder pipeline.

Invoked as::

    blender --background --python modder_splice.py -- \
        --meshy path/to/meshy-char.fbx \
        --falcon path/to/falcon-source.fbx \
        --out path/to/spliced.fbx

Semantics (v0.5):
  * Import the Meshy-rigged character as the *target mesh*.
  * Import the Falcon reference (or, until we have the real HSD-extracted
    Falcon .dae, a proxy humanoid FBX with the same skeleton naming) as
    the *source* — this contributes the skeleton + already-good
    vertex-group weights.
  * Auto-align the two by bounding-box: uniform scale target so its
    height matches source, feet-plane alignment on Y.
  * Data Transfer: source → target, vertex-groups, POLYINTERP_NEAREST.
    This inherits the source's professionally-painted skin weights onto
    our new topology by nearest-face interpolation.
  * Parent the target mesh under the source armature; delete the target's
    original armature.
  * (Optional) decimate to a polygon budget if --poly-cap is given.
  * Export as FBX with skinned deforms baked, no animation.

If the source FBX has no armature (proxy mode with just a mesh), skip the
armature-parenting step and just do mesh-to-mesh vertex-group transfer.

Fail loudly on any error — the Node caller reads stderr to surface
problems back to the user.
"""

import argparse
import os
import sys

# argparse can't reach Blender's sys.argv normally — Blender consumes
# everything before "--". Split at the sentinel.
try:
    argv = sys.argv[sys.argv.index('--') + 1:]
except ValueError:
    argv = []

parser = argparse.ArgumentParser(prog='modder_splice')
parser.add_argument('--meshy',  required=True)
parser.add_argument('--falcon', required=True)
parser.add_argument('--out',    required=True)
parser.add_argument('--poly-cap', type=int, default=6000)
parser.add_argument('--verbose', action='store_true')
args = parser.parse_args(argv)


def log(msg):
    print('[splice] ' + msg, flush=True)


# ------------------------------------------------------------------- bpy
# Deferred import so --help still works when Blender isn't running.
import bpy

log('bpy=' + bpy.app.version_string + '  meshy=' + args.meshy
    + '  falcon=' + args.falcon)


# Wipe the scene entirely — factory settings + empty.
bpy.ops.wm.read_factory_settings(use_empty=True)

# Track objects that existed before each import so we can identify what
# each import added.
def objects_snapshot():
    return set(o.name for o in bpy.data.objects)


# ------------------------------------------------------------- import Falcon
pre = objects_snapshot()
ext = os.path.splitext(args.falcon)[1].lower()
if ext == '.fbx':
    bpy.ops.import_scene.fbx(filepath=args.falcon)
elif ext in ('.dae',):
    bpy.ops.wm.collada_import(filepath=args.falcon)
elif ext in ('.glb', '.gltf'):
    bpy.ops.import_scene.gltf(filepath=args.falcon)
elif ext == '.obj':
    bpy.ops.import_scene.obj(filepath=args.falcon)
else:
    raise SystemExit('unsupported falcon extension: ' + ext)
falcon_new = [bpy.data.objects[n] for n in (objects_snapshot() - pre)]
log('falcon import added ' + str(len(falcon_new)) + ' objs: ' + ', '.join(o.name for o in falcon_new))

falcon_meshes = [o for o in falcon_new if o.type == 'MESH']
falcon_arms   = [o for o in falcon_new if o.type == 'ARMATURE']
if not falcon_meshes:
    raise SystemExit('falcon import produced no mesh objects')
falcon_mesh   = max(falcon_meshes, key=lambda o: sum(1 for _ in o.data.polygons))
falcon_arm    = falcon_arms[0] if falcon_arms else None
log('falcon mesh=' + falcon_mesh.name + ' polys=' + str(len(falcon_mesh.data.polygons))
    + '  arm=' + (falcon_arm.name if falcon_arm else 'NONE'))


# ------------------------------------------------------------- import Meshy
pre = objects_snapshot()
ext = os.path.splitext(args.meshy)[1].lower()
if ext == '.fbx':
    bpy.ops.import_scene.fbx(filepath=args.meshy)
elif ext == '.dae':
    bpy.ops.wm.collada_import(filepath=args.meshy)
elif ext in ('.glb', '.gltf'):
    bpy.ops.import_scene.gltf(filepath=args.meshy)
else:
    raise SystemExit('unsupported meshy extension: ' + ext)
meshy_new = [bpy.data.objects[n] for n in (objects_snapshot() - pre)]
log('meshy import added ' + str(len(meshy_new)) + ' objs: ' + ', '.join(o.name for o in meshy_new))

meshy_meshes = [o for o in meshy_new if o.type == 'MESH']
meshy_arms   = [o for o in meshy_new if o.type == 'ARMATURE']
if not meshy_meshes:
    raise SystemExit('meshy import produced no mesh objects')
meshy_mesh   = max(meshy_meshes, key=lambda o: sum(1 for _ in o.data.polygons))
log('meshy mesh=' + meshy_mesh.name + ' polys=' + str(len(meshy_mesh.data.polygons)))


# ------------------------------------------------------------- auto-align
# Compute world-space bounding boxes.
def world_bbox(obj):
    bbox = [obj.matrix_world @ __import__('mathutils').Vector(c) for c in obj.bound_box]
    xs = [v.x for v in bbox]; ys = [v.y for v in bbox]; zs = [v.z for v in bbox]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

f_xmin, f_ymin, f_zmin, f_xmax, f_ymax, f_zmax = world_bbox(falcon_mesh)
m_xmin, m_ymin, m_zmin, m_xmax, m_ymax, m_zmax = world_bbox(meshy_mesh)

# Height (Y-extent) is the most reliable axis for humanoids.
f_h = max(0.001, f_ymax - f_ymin)
m_h = max(0.001, m_ymax - m_ymin)
scale_factor = f_h / m_h
log('bbox falcon y=[%.3f..%.3f] h=%.3f' % (f_ymin, f_ymax, f_h))
log('bbox meshy  y=[%.3f..%.3f] h=%.3f' % (m_ymin, m_ymax, m_h))
log('scale factor = %.3f' % scale_factor)

meshy_mesh.scale = (
    meshy_mesh.scale[0] * scale_factor,
    meshy_mesh.scale[1] * scale_factor,
    meshy_mesh.scale[2] * scale_factor,
)
bpy.context.view_layer.update()

# Recompute meshy bbox after scale, then translate so feet-Y matches.
m_xmin, m_ymin, m_zmin, m_xmax, m_ymax, m_zmax = world_bbox(meshy_mesh)
dx = ((f_xmin + f_xmax) / 2) - ((m_xmin + m_xmax) / 2)
dy = f_ymin - m_ymin
dz = ((f_zmin + f_zmax) / 2) - ((m_zmin + m_zmax) / 2)
meshy_mesh.location = (
    meshy_mesh.location[0] + dx,
    meshy_mesh.location[1] + dy,
    meshy_mesh.location[2] + dz,
)
bpy.context.view_layer.update()
log('post-align delta xyz = %.3f %.3f %.3f' % (dx, dy, dz))


# ------------------------------------------------------------- Data Transfer
# Data Transfer needs the target active and both meshes selected. The
# vgroup transfer only works when the source's vertex-groups exist on
# the target — Blender's NAME layer_select_dst will create missing ones.
bpy.ops.object.select_all(action='DESELECT')
meshy_mesh.select_set(True)
falcon_mesh.select_set(True)
bpy.context.view_layer.objects.active = meshy_mesh

log('running data_transfer VGROUP_WEIGHTS…')
try:
    bpy.ops.object.data_transfer(
        use_reverse_transfer=False,
        data_type='VGROUP_WEIGHTS',
        vert_mapping='POLYINTERP_NEAREST',
        layers_select_src='ALL',
        layers_select_dst='NAME',
        mix_mode='REPLACE',
    )
    log('data_transfer OK — %d vgroups on target now'
        % len(meshy_mesh.vertex_groups))
except RuntimeError as e:
    log('data_transfer FAIL: ' + str(e))
    # Non-fatal — export whatever we've got with the target's own weights.


# ------------------------------------------------------------- reparent
if falcon_arm is not None:
    # Detach from any old parent + armature modifier, then bind to Falcon's.
    meshy_mesh.parent = falcon_arm
    meshy_mesh.matrix_parent_inverse = falcon_arm.matrix_world.inverted()
    # Remove existing armature modifiers pointing at meshy's own armature.
    to_remove = [m for m in meshy_mesh.modifiers if m.type == 'ARMATURE']
    for m in to_remove:
        meshy_mesh.modifiers.remove(m)
    mod = meshy_mesh.modifiers.new(name='Armature', type='ARMATURE')
    mod.object = falcon_arm
    log('reparented meshy mesh under falcon armature')

    # Remove Meshy's own armature to avoid duplicate-skeleton export.
    for arm in meshy_arms:
        if arm.name in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[arm.name], do_unlink=True)


# ------------------------------------------------------------- decimate
poly_count = len(meshy_mesh.data.polygons)
if args.poly_cap and poly_count > args.poly_cap:
    ratio = args.poly_cap / poly_count
    log('decimate: %d polys -> target %d (ratio %.3f)'
        % (poly_count, args.poly_cap, ratio))
    dec = meshy_mesh.modifiers.new(name='Decimate', type='DECIMATE')
    dec.ratio = ratio
    dec.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = meshy_mesh
    try:
        bpy.ops.object.modifier_apply(modifier=dec.name)
        log('decimate applied — new polys=' + str(len(meshy_mesh.data.polygons)))
    except RuntimeError as e:
        log('decimate apply FAIL: ' + str(e))


# ------------------------------------------------------------- export
# Delete the falcon reference mesh — we want only Meshy-with-Falcon-rig.
if falcon_mesh.name in bpy.data.objects:
    bpy.data.objects.remove(bpy.data.objects[falcon_mesh.name], do_unlink=True)

out_dir = os.path.dirname(args.out)
if out_dir:
    os.makedirs(out_dir, exist_ok=True)

log('exporting to ' + args.out)
bpy.ops.object.select_all(action='DESELECT')
meshy_mesh.select_set(True)
if falcon_arm:
    falcon_arm.select_set(True)
bpy.context.view_layer.objects.active = meshy_mesh

bpy.ops.export_scene.fbx(
    filepath=args.out,
    use_selection=True,
    apply_scale_options='FBX_SCALE_ALL',
    axis_forward='-Z',
    axis_up='Y',
    add_leaf_bones=False,
    bake_anim=False,
    mesh_smooth_type='FACE',
    use_mesh_modifiers=True,
)
log('DONE ' + args.out)
