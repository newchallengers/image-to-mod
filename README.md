# image-to-mod

Photo → automatic **Super Smash Bros. Melee** character skin mod.

Upload a selfie, get back a real `PlCa.dat` (or any other Melee character `.DAT`
you supply) with your face on it — ready to drop into your ISO.

Live at **[d20.finance/modder](https://d20.finance/modder)** (also `/smash`).

## The pipeline

```
photo.png
   │
   ▼
[1] Gemini nano-banana
    strict T-pose, standardized proportions, grey background
   │
   ▼
[2] Meshy AI
    image-to-3d  →  auto-rigged FBX
   │
   ▼
[3] hsdcli extract-scene
    parses your uploaded base .DAT via a headless port of Ploaj/HSDLib,
    emits Falcon's real 63-JOBJ skeleton + 17 meshes as Collada
   │
   ▼
[4] Blender (headless)
    imports Falcon.dae armature + your Meshy FBX side-by-side,
    auto-aligns bounding boxes, Data-Transfer VGROUP_WEIGHTS,
    parents your mesh under Falcon's armature, decimates to Melee's
    poly budget, exports as FBX
   │
   ▼
[5] hsdcli splice-mesh
    loads the base .DAT, swaps the character mesh via the ported
    HSDLib ModelImporter, saves modded .DAT
   │
   ▼
downloadable mod-*.dat
```

End-to-end from HTTP POST to downloadable `.DAT`: **~3.7 seconds**
(after Meshy's ~5 min photo→rig, which happens once per character upload).

## Repository layout

```
/frontend/modder.html        the single-file UI (three.js, Mario BG, drag-rotate)
/server/modder.js            standalone Express backend, ~470 lines
/blender/splice.py           headless Blender script — Data Transfer + decimate
/hsdcli/HSDCli.cs            C# CLI wrapping HSDRaw + IONET
/hsdcli/HSDCli.csproj
/hsdcli/hsdlib_import/       adapted-headless HSDRaw import files (see LICENSE)
LICENSE                      MIT + third-party attributions
README.md                    (this file)
```

## Requirements

You supply your own installations of:

| Tool                | What for                             | Where to get                                    |
|---------------------|--------------------------------------|-------------------------------------------------|
| Node.js 18+         | run `modder.js`                      | https://nodejs.org                              |
| .NET 8 SDK          | build & run `hsdcli`                 | `dotnet-install.sh --channel 8.0`               |
| Blender 3.4+        | run `splice.py` headless             | `apt install blender` or the tarball            |
| Ploaj/HSDLib        | provides `HSDRaw.dll` + `IONET.dll`  | `git clone https://github.com/Ploaj/HSDLib`     |
| Meshy AI key        | image-to-3d + rigging                | https://meshy.ai                                |
| Google Gemini key   | nano-banana image model              | https://aistudio.google.com                     |

## Building

```bash
# 1. Get HSDLib + build HSDRaw.dll
git clone https://github.com/Ploaj/HSDLib /opt/HSDLib
cd /opt/HSDLib/HSDRaw && dotnet build -c Release   # emits HSDRaw.dll

# 2. Build our CLI (references HSDRaw.dll + IONET.dll from HSDLib repo)
cd /path/to/image-to-mod/hsdcli
dotnet build -c Release   # emits bin/Release/net8.0/hsdcli.dll

# 3. Node deps for the server
cd /path/to/image-to-mod/server
npm install express axios

# 4. Put your API keys somewhere modder.js can read them
mkdir -p ~/.config
echo YOUR_MESHY_TOKEN  > ~/.config/modder-meshy.key
echo YOUR_GEMINI_KEY   > ~/.config/modder-gemini.key
chmod 600 ~/.config/modder-*.key
```

## Running

```bash
# One-shot (foreground)
PORT=3010 \
STORAGE_ROOT=/var/lib/modder \
BLENDER_SCRIPT=/path/to/image-to-mod/blender/splice.py \
HSDCLI_DLL=/path/to/image-to-mod/hsdcli/bin/Release/net8.0/hsdcli.dll \
PUBLIC_BASE_URL=https://your.example.com \
node server/modder.js
```

Or wire it up to `supervisord` / `systemd` for auto-restart.

`modder.html` calls a backend at `const API = 'https://your.example.com/api-modder'`
by default. You can override at runtime with `?api=http://localhost:3010`.

## HTTP API

All endpoints return JSON unless noted. Universal CORS (`Access-Control-Allow-Origin: *`).

| Method + path                          | Purpose                                                          |
|----------------------------------------|------------------------------------------------------------------|
| `GET  /modder/health`                  | Config sanity check: keys loaded, external tools present         |
| `POST /modder/generate`                | Body `{image: "data:image/png;base64,…"}` → `{task_id}`          |
| `GET  /modder/status/:taskId`          | Meshy polling: image → rigging → SUCCEEDED with `rig_task_id`    |
| `GET  /modder/model?url=<meshy-url>`   | CORS-friendly proxy for Meshy CDN GLB fetches                    |
| `GET  /modder/fbx/:rigTaskId`          | Streams the rigged FBX (auto-mirrored from Meshy)                |
| `POST /modder/base-dat`                | Body `{filename, data_b64}` → `{dat_id}`. Your base .DAT upload  |
| `POST /modder/process/:rigTaskId`      | Body `{base_dat_id}` → runs the full pipeline, returns `.DAT`    |
| `GET  /modder/download/:filename`      | Streams a produced `mod-*.dat` or `splice-*.fbx`                 |
| `POST /modder/dev-iso?name=…`          | Raw binary body: stream-upload a Melee ISO (dev-only)            |
| `POST /modder/dev-fixture`             | Body `{filename, data_b64}`: seed a reference .DAT (dev-only)    |
| `GET  /modder/logs?limit=N`            | Recent server ring-buffer logs                                   |
| `POST /modder/frontlog`                | Body `{msg}`: forward a browser-side log line into server buffer |

## Copyright

**You must upload your own base .DAT** — extracted from your own legally-owned
Melee disc. Same for the ISO if you use the (WIP) in-game test loop. Nothing
Nintendo/HAL copyrighted is bundled with this software. Uploads are stored
SHA-256-hashed and are never publicly listed.

Super Smash Bros. Melee is © 2001 HAL Laboratory / Nintendo. This project has
no affiliation with them, or with Ploaj who wrote HSDLib.

## Credits

- **Ploaj** — for HSDRaw / HSDRawViewer / IONET, without which none of this works.
- **DRGN** — for DAT Texture Wizard, whose ISO-injection primitives inspired the
  planned in-game test loop.
- The Melee modding community for reverse-engineering HSD file format documentation
  over the past twenty-plus years.

## License

MIT — see [LICENSE](LICENSE) for full terms and third-party attributions.
