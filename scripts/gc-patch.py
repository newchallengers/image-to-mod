#!/usr/bin/env python3
"""
In-place file replacement inside a GameCube ISO.

Locates a target filename in the FST, and either overwrites the file's
existing region (if new data fits) or appends new data at end-of-used
space and rewrites the FST entry to point there. Preserves the disc's
fixed 1.4 GB total size.

Usage:
    gc-patch.py <src.iso> <dst.iso> <target_filename> <replacement_path>

Example:
    gc-patch.py TM.iso patched.iso PlCaNr.dat mod-something.dat
"""
import sys, os, shutil, struct

if len(sys.argv) != 5:
    print(__doc__); sys.exit(1)

src, dst, target_name, replacement = sys.argv[1:5]

# GameCube boot.bin header: FST offset at 0x424, FST size at 0x428, max at 0x42C
with open(src, 'rb') as f:
    f.seek(0x424)
    fst_offset, fst_size, fst_max = struct.unpack('>III', f.read(12))
print(f'FST: offset=0x{fst_offset:x} size=0x{fst_size:x} max=0x{fst_max:x}')

# Read the FST
with open(src, 'rb') as f:
    f.seek(fst_offset)
    fst_blob = f.read(fst_size)

# Root entry: bytes 8-11 = total number of entries
num_entries = struct.unpack('>I', fst_blob[8:12])[0]
print(f'FST entries: {num_entries}')

# String table follows the entries
str_table_off = num_entries * 12

def entry(i):
    e = fst_blob[i*12:(i+1)*12]
    is_dir = e[0]
    name_off = struct.unpack('>I', b'\x00' + e[1:4])[0]
    off_or_parent = struct.unpack('>I', e[4:8])[0]
    size_or_next = struct.unpack('>I', e[8:12])[0]
    if i == 0:
        name = ''
    else:
        end = fst_blob.index(b'\x00', str_table_off + name_off)
        name = fst_blob[str_table_off + name_off:end].decode('ascii', errors='replace')
    return is_dir, name, off_or_parent, size_or_next

# Find target file
target_i = None
for i in range(num_entries):
    is_dir, name, off, sz = entry(i)
    if not is_dir and name.lower() == target_name.lower():
        target_i = i
        target_off, target_sz = off, sz
        print(f'FOUND {name} at entry {i}: offset=0x{off:x} size={sz} ({sz/1024:.1f} KB)')
        break
if target_i is None:
    print(f'{target_name} not found'); sys.exit(2)

# Read replacement
with open(replacement, 'rb') as f:
    new_data = f.read()
new_sz = len(new_data)
print(f'Replacement: {new_sz} bytes ({new_sz/1024:.1f} KB)  delta={new_sz-target_sz}')

# Copy src → dst
if src != dst:
    print(f'Copying {src} -> {dst}...')
    shutil.copyfile(src, dst)

# Two paths:
# a) new_sz <= target_sz: overwrite in place, update FST size only
# b) new_sz  > target_sz: append at end of used region + update FST offset+size

if new_sz <= target_sz:
    # Fits — overwrite + pad with zeros to keep alignment
    with open(dst, 'r+b') as f:
        f.seek(target_off)
        f.write(new_data)
        f.write(b'\x00' * (target_sz - new_sz))   # zero-fill the rest
        # Update size in FST entry
        f.seek(fst_offset + target_i*12 + 8)
        f.write(struct.pack('>I', new_sz))
    print('in-place overwrite done')
else:
    # Bigger — find highest end-of-file offset across the whole FST, that's the used-region end.
    max_end = 0
    for i in range(num_entries):
        is_dir, name, off, sz = entry(i)
        if not is_dir:
            end = off + sz
            if end > max_end: max_end = end
    print(f'used region ends at 0x{max_end:x} ({max_end/(1024*1024):.1f} MB)')
    # Align new position to 32 KiB (0x8000) sector boundary — GameCube convention
    ALIGN = 0x8000
    new_off = (max_end + ALIGN - 1) & ~(ALIGN - 1)
    disc_size = os.path.getsize(src)
    if new_off + new_sz > disc_size:
        print(f'ERROR: no free space ({new_off + new_sz - disc_size} bytes short)'); sys.exit(3)
    print(f'placing new data at 0x{new_off:x} (slack from 0x{max_end:x}, {(new_off - max_end)/1024:.1f} KB alignment gap)')
    with open(dst, 'r+b') as f:
        f.seek(new_off)
        f.write(new_data)
        # Update FST entry: bytes 4-7 = new offset, 8-11 = new size
        f.seek(fst_offset + target_i*12 + 4)
        f.write(struct.pack('>II', new_off, new_sz))
    print('appended + FST updated')

# Verify
with open(dst, 'rb') as f:
    f.seek(fst_offset + target_i*12)
    e = f.read(12)
    verify_off = struct.unpack('>I', e[4:8])[0]
    verify_sz  = struct.unpack('>I', e[8:12])[0]
print(f'VERIFY entry {target_i}: offset=0x{verify_off:x} size={verify_sz}')
if verify_sz != new_sz:
    print('WARNING: size mismatch'); sys.exit(4)
print('done')
