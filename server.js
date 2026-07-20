#!/usr/bin/env node
/*
 * modder.js — standalone Express backend for the "Image to Mod" pipeline.
 *
 *   photo → Gemini nano-banana T-pose extension
 *        → Meshy image-to-3d + rigging
 *        → hsdcli extract-scene (Falcon.dae from user's own base .DAT)
 *        → Blender headless Data Transfer
 *        → hsdcli splice-mesh (via ported Ploaj/HSDLib ModelImporter)
 *        → downloadable modded .DAT
 *
 * Runs on its own PORT (default 3010) so it's isolated from any other
 * Node service on the same box. Point your frontend at the URL that
 * reaches this port through your reverse proxy.
 *
 * Config — reads on boot from these paths (adjust via env vars):
 *   MESHY_KEY_FILE   default: ~/.config/modder-meshy.key   (Meshy Bearer token)
 *   GEMINI_KEY_FILE  default: ~/.config/modder-gemini.key  (Gemini API key)
 *   STORAGE_ROOT     default: /var/lib/modder              (all persistent data)
 *   PUBLIC_BASE_URL  default: http://localhost:3010        (URLs handed to clients)
 *   BLENDER          default: /usr/bin/blender
 *   BLENDER_SCRIPT   default: ./blender/splice.py
 *   HSDCLI_DOTNET    default: /opt/dotnet/dotnet
 *   HSDCLI_DLL       default: ./hsdcli/bin/Release/net8.0/hsdcli.dll
 *   HSDCLI_DOTNET_ROOT default: /opt/dotnet
 *   PORT             default: 3010
 *
 * Storage layout (under STORAGE_ROOT):
 *   uploads/          → banana-extended source PNGs (public via /public/uploads)
 *   fbx/{rig}.fbx     → auto-mirrored rigged FBX from Meshy
 *   base-dats/{sha}.dat → user-uploaded base character .DATs (private)
 *   base-dats/dev-fixtures/*.dat → optional dev-only reference DATs
 *   isos/{name}       → user-uploaded Melee ISOs for in-game test loop (private)
 *   mods/{outputs}    → produced FBX + modded .DATs (public via /public/mods)
 *   logs/             → JSON per-request logs
 *   state/anims.json  → cache metadata (Meshy task ids, output paths)
 *
 * Copyright policy:
 *   Users MUST upload their own base .DAT (extracted from their own game
 *   disc) and their own ISO. Nothing Nintendo-copyrighted is shipped here.
 *   Uploads are stored SHA-256-hashed and never publicly listed.
 */

'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────
const CFG = {
    port:              parseInt(process.env.PORT || '3010', 10),
    publicBase:        process.env.PUBLIC_BASE_URL || 'http://localhost:3010',
    storageRoot:       process.env.STORAGE_ROOT   || '/var/lib/modder',
    meshyKeyFile:      process.env.MESHY_KEY_FILE  || path.join(os.homedir(), '.config/modder-meshy.key'),
    geminiKeyFile:     process.env.GEMINI_KEY_FILE || path.join(os.homedir(), '.config/modder-gemini.key'),
    blender:           process.env.BLENDER        || '/usr/bin/blender',
    blenderScript:     process.env.BLENDER_SCRIPT || path.resolve(__dirname, '../blender/splice.py'),
    dotnet:            process.env.HSDCLI_DOTNET  || '/opt/dotnet/dotnet',
    hsdcliDll:         process.env.HSDCLI_DLL     || path.resolve(__dirname, '../hsdcli/bin/Release/net8.0/hsdcli.dll'),
    dotnetRoot:        process.env.HSDCLI_DOTNET_ROOT || '/opt/dotnet',
};

const dirs = {
    uploads:  path.join(CFG.storageRoot, 'uploads'),
    fbx:      path.join(CFG.storageRoot, 'fbx'),
    baseDats: path.join(CFG.storageRoot, 'base-dats'),
    isos:     path.join(CFG.storageRoot, 'isos'),
    mods:     path.join(CFG.storageRoot, 'mods'),
    logs:     path.join(CFG.storageRoot, 'logs'),
    state:    path.join(CFG.storageRoot, 'state'),
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

function readKey(p) {
    try { return fs.readFileSync(p, 'utf8').trim() || null; }
    catch (_) { return null; }
}
const MESHY_KEY  = readKey(CFG.meshyKeyFile);
const GEMINI_KEY = readKey(CFG.geminiKeyFile);
if (!MESHY_KEY)  console.warn('[warn] no Meshy key at ' + CFG.meshyKeyFile);
if (!GEMINI_KEY) console.warn('[warn] no Gemini key at ' + CFG.geminiKeyFile);

// ─── Promo codes ─────────────────────────────────────────────────────
// Server-side allowlist of shareable codes that let a caller consume
// N free /modder/generate runs (which are the paid step — Meshy + Gemini).
// Codes are NEVER embedded in the frontend or repo; they live in a
// deploy-only file. Format:
//   { "SOMEPHRASE": { "remaining": 5 }, ... }
// Case-insensitive. Consumption count is persisted separately so hot
// edits to the allowlist don't reset usage. Absent file = no free
// generates; the endpoint returns 402 with a friendly message.
const PROMO_CODES_FILE = process.env.PROMO_CODES_FILE
    || path.join(os.homedir(), '.config/modder-promo-codes.json');
const PROMO_USED_PATH  = path.join(dirs.state, 'promo-used.json');
let promoAllowlist = {};   // { "CODE": { remaining: N } }
let promoUsed      = {};   // { "CODE": N }
function loadPromoAllowlist() {
    try {
        const raw = JSON.parse(fs.readFileSync(PROMO_CODES_FILE, 'utf8'));
        const norm = {};
        for (const k of Object.keys(raw)) norm[k.trim().toUpperCase()] = raw[k];
        promoAllowlist = norm;
        console.log('[promo] loaded ' + Object.keys(norm).length + ' code(s) from ' + PROMO_CODES_FILE);
    } catch (e) { promoAllowlist = {}; if (e.code !== 'ENOENT') console.warn('[promo] load fail: ' + e.message); }
}
function loadPromoUsed() {
    try { promoUsed = JSON.parse(fs.readFileSync(PROMO_USED_PATH, 'utf8')) || {}; }
    catch (_) { promoUsed = {}; }
}
function savePromoUsed() {
    try { fs.writeFileSync(PROMO_USED_PATH, JSON.stringify(promoUsed, null, 2)); }
    catch (e) { console.warn('[promo] save used fail: ' + e.message); }
}
loadPromoAllowlist();
loadPromoUsed();
function promoNormalize(code) { return String(code || '').trim().toUpperCase(); }
function promoRemaining(code) {
    const c = promoNormalize(code);
    if (!promoAllowlist[c]) return null;   // unknown code
    const cap = Math.max(0, parseInt(promoAllowlist[c].remaining || 0, 10));
    const used = Math.max(0, parseInt(promoUsed[c] || 0, 10));
    return Math.max(0, cap - used);
}
function promoConsume(code) {
    const c = promoNormalize(code);
    if (!promoAllowlist[c]) return false;
    if (promoRemaining(c) <= 0) return false;
    promoUsed[c] = (promoUsed[c] || 0) + 1;
    savePromoUsed();
    console.log('[promo] consumed 1 from ' + c + ' (used=' + promoUsed[c] + ')');
    return true;
}

// ─── Logging ─────────────────────────────────────────────────────────
const LOG_MAX = 400;
const ringBuf = [];
function log(tag, msg) {
    const line = new Date().toISOString() + '  [' + tag + '] ' + msg;
    ringBuf.push(line);
    while (ringBuf.length > LOG_MAX) ringBuf.shift();
    console.log(line);
}

// ─── State ───────────────────────────────────────────────────────────
const STATE_PATH = path.join(dirs.state, 'anims.json');
let state = { rigs: {} };  // rigTaskId → { fbxUrl, fbxLocalPath, mods: {datHash: outPath} }
try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) || state; } catch (_) {}
function saveState() {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
    catch (e) { log('boot', 'save state fail: ' + e.message); }
}

// ─── Small helpers ───────────────────────────────────────────────────
function safeId(s, max = 100) {
    return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, max);
}
function safeFilename(s, max = 100) {
    return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, max);
}
function extractRigTaskIdFromUrl(url) {
    const m = /\/tasks\/([0-9a-f-]{20,})\//i.exec(url || '');
    return m ? m[1] : null;
}

// ─── Meshy: image-to-3d + rigging ────────────────────────────────────
async function meshyStartImage3d(publicImageUrl) {
    const r = await axios.post(
        'https://api.meshy.ai/openapi/v1/image-to-3d',
        {
            image_url: publicImageUrl,
            enable_pbr: false,
            should_texture: true,
            ai_model: 'meshy-4',
        },
        {
            headers: { Authorization: 'Bearer ' + MESHY_KEY, 'Content-Type': 'application/json' },
            timeout: 60000,
            validateStatus: null,
        }
    );
    if (r.status >= 400) throw new Error('meshy image-to-3d ' + r.status + ': ' + JSON.stringify(r.data));
    const taskId = r.data && (r.data.result || r.data.id);
    if (!taskId) throw new Error('meshy image-to-3d returned no task id');
    return taskId;
}

async function meshyGetImageStatus(taskId) {
    const r = await axios.get(
        'https://api.meshy.ai/openapi/v1/image-to-3d/' + taskId,
        { headers: { Authorization: 'Bearer ' + MESHY_KEY }, timeout: 15000, validateStatus: null }
    );
    if (r.status >= 400) throw new Error('meshy image status ' + r.status);
    return r.data || {};
}

async function meshyStartRig(imageTaskId, imageGlbUrl) {
    const r = await axios.post(
        'https://api.meshy.ai/openapi/v1/rigging',
        { input_task_id: imageTaskId, model_url: imageGlbUrl },
        {
            headers: { Authorization: 'Bearer ' + MESHY_KEY, 'Content-Type': 'application/json' },
            timeout: 30000,
            validateStatus: null,
        }
    );
    if (r.status >= 400) throw new Error('meshy rigging ' + r.status + ': ' + JSON.stringify(r.data));
    const rigId = r.data && (r.data.result || r.data.id);
    if (!rigId) throw new Error('meshy rigging returned no task id');
    return rigId;
}

async function meshyGetRigStatus(rigId) {
    const r = await axios.get(
        'https://api.meshy.ai/openapi/v1/rigging/' + rigId,
        { headers: { Authorization: 'Bearer ' + MESHY_KEY }, timeout: 15000, validateStatus: null }
    );
    if (r.status >= 400) throw new Error('meshy rig status ' + r.status);
    return r.data || {};
}

// ─── Gemini nano-banana T-pose extension ─────────────────────────────
async function bananaExtendToTpose(bytes, mime) {
    const prompt = [
        'Redraw the person in the attached photo as a FULL BODY 3D-style character in a STRICT T-POSE.',
        'PROPORTIONS: standard humanoid, ~8 heads tall, adult body proportions regardless of source image proportions.',
        'POSE (exact): standing bolt upright, feet together, arms EXACTLY horizontal at shoulder height forming a perfect T, palms facing DOWN, elbows straight, fingers straight, head level and facing camera directly, spine vertical, no hip cock, no lean.',
        'FRAMING (exact): square 1:1 image, character centered horizontally, top of head at 10% from top edge, feet at 90% from top edge, camera at chest height, no perspective foreshortening, full body head to feet visible.',
        "IDENTITY: preserve the person's face, hair style + color, and clothing colors from the photo. If chest-up only in source, extend to full body with proportional pants + shoes matching the shirt/hair style.",
        'BACKGROUND: solid neutral grey (#7f7f7f). Absolutely no shadows on ground, no floor, no props, no other characters.',
        'STYLE: clean cartoon/anime 3D avatar aesthetic with soft outlines, flat colors, no photorealism.',
    ].join(' ');
    const b64 = bytes.toString('base64');
    for (const model of ['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview']) {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + GEMINI_KEY;
        const r = await axios.post(url, {
            contents: [{
                parts: [
                    { inlineData: { mimeType: mime, data: b64 } },
                    { text: prompt },
                ],
            }],
            generationConfig: { responseModalities: ['IMAGE'] },
        }, { timeout: 60000, validateStatus: null });
        if (r.status >= 400) { log('banana', model + ' HTTP ' + r.status); continue; }
        const parts = r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts;
        if (!parts) { log('banana', model + ' no parts'); continue; }
        const inline = parts.find(p => p.inlineData && p.inlineData.data);
        if (!inline) { log('banana', model + ' no inlineData'); continue; }
        return {
            bytes: Buffer.from(inline.inlineData.data, 'base64'),
            mime:  inline.inlineData.mimeType || 'image/png',
            model,
        };
    }
    throw new Error('all Gemini banana models failed');
}

// ─── FBX auto-mirror ─────────────────────────────────────────────────
function fbxPath(rigId)   { return path.join(dirs.fbx, rigId + '.fbx'); }
function fbxHasLocal(rig) { try { return fs.statSync(fbxPath(rig)).size > 1024; } catch (_) { return false; } }
async function fbxMirror(rigId, remoteUrl) {
    if (fbxHasLocal(rigId)) return true;
    const r = await axios.get(remoteUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: null, maxContentLength: 100 * 1024 * 1024 });
    if (r.status >= 400 || !r.data) { log('fbx', rigId.slice(-6) + ' HTTP ' + r.status); return false; }
    fs.writeFileSync(fbxPath(rigId), Buffer.from(r.data));
    log('fbx', rigId.slice(-6) + ' saved ' + r.data.byteLength + 'B');
    return true;
}

// ─── Blender + hsdcli invocation ─────────────────────────────────────
function runBlender(meshyFbx, referenceFile, outFbx, cb) {
    const args = [
        '--background',
        '--python', CFG.blenderScript,
        '--',
        '--meshy',  meshyFbx,
        '--falcon', referenceFile,
        '--out',    outFbx,
    ];
    execFile(CFG.blender, args, { timeout: 4 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, cb);
}
function runHsdcli(subargs, cb) {
    execFile(CFG.dotnet, [CFG.hsdcliDll, ...subargs],
        {
            timeout: 60 * 1000,
            maxBuffer: 8 * 1024 * 1024,
            env: Object.assign({}, process.env, { DOTNET_ROOT: CFG.dotnetRoot }),
        },
        cb);
}

// ─── Express app ─────────────────────────────────────────────────────
const app = express();

// Universal CORS — the modder frontend is served from a different origin.
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Promo-Code');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// Static public dirs — banana T-pose images, produced mods.
app.use('/public/uploads', express.static(dirs.uploads));
app.use('/public/mods',    express.static(dirs.mods));

// ─── Ingest: photo upload ────────────────────────────────────────────
/**
 * POST /modder/generate
 * body: { image: "data:image/png;base64,..." }
 * Runs nano-banana T-pose extension, uploads the extended PNG to public
 * disk, kicks off Meshy image-to-3d. Returns { task_id }.
 */
app.post('/modder/generate', express.json({ limit: '8mb' }), async (req, res) => {
    try {
        if (!MESHY_KEY || !GEMINI_KEY) return res.status(503).json({ ok: false, error: 'server not configured' });
        // Promo gate — /generate is the paid step (Meshy + Gemini).
        // Client sends header X-Promo-Code (or body.promo_code) with a
        // valid, un-exhausted code. Consume one credit atomically before
        // any external API call; if it fails downstream we accept the
        // small cost of a wasted credit over the racier alternative.
        const promoCode = req.header('X-Promo-Code') || (req.body && req.body.promo_code) || '';
        const rem = promoRemaining(promoCode);
        if (rem === null || rem <= 0) {
            return res.status(402).json({ ok: false, error: 'promo_required',
                message: 'Enter a valid promo code (FREE MODS LEFT: 0).' });
        }
        if (!promoConsume(promoCode)) {
            return res.status(402).json({ ok: false, error: 'promo_exhausted',
                message: 'That promo code just ran out.' });
        }
        const dataUrl = String((req.body && (req.body.image || req.body.image_data_url)) || '');
        const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(dataUrl);
        if (!m) return res.status(400).json({ ok: false, error: 'body.image must be a base64 data URL (image/png|jpeg|webp)' });
        const inputBytes = Buffer.from(m[2], 'base64');
        const inputMime  = m[1];
        log('gen', 'received ' + inputBytes.length + 'B mime=' + inputMime);

        // Banana T-pose
        const ext = await bananaExtendToTpose(inputBytes, inputMime);
        log('gen', 'banana done ' + ext.bytes.length + 'B via ' + ext.model);

        // Save extended PNG publicly so Meshy can fetch it
        const stamp = crypto.randomBytes(8).toString('hex');
        const fname = 'fullbody-' + stamp + '.png';
        const dst   = path.join(dirs.uploads, fname);
        fs.writeFileSync(dst, ext.bytes);
        const publicUrl = CFG.publicBase.replace(/\/$/, '') + '/public/uploads/' + fname;

        // Kick Meshy
        const taskId = await meshyStartImage3d(publicUrl);
        log('gen', 'meshy started task=' + taskId + ' src=' + publicUrl);
        res.json({ ok: true, task_id: taskId, extended_url: publicUrl });
    } catch (err) {
        log('gen', 'FAIL ' + err.message);
        res.status(502).json({ ok: false, error: err.message });
    }
});

/**
 * GET /modder/status/:taskId
 * Polls Meshy for image status; when done, auto-kicks rigging; when rig
 * done, mirrors FBX to /fbx/ and returns the character model URL. Response:
 * { ok, phase: 'image'|'rigging', status, progress, model_url|null, rig_task_id|null }
 */
const rigLinks = {};   // imageTaskId → rigTaskId
const rigStarting = new Set();
app.get('/modder/status/:taskId', async (req, res) => {
    try {
        if (!MESHY_KEY) return res.status(503).json({ ok: false, error: 'no Meshy key' });
        const tid = safeId(req.params.taskId);
        if (!tid) return res.status(400).json({ ok: false, error: 'bad task id' });
        const img = await meshyGetImageStatus(tid);
        const iSt = img.status || '?';
        const iPg = typeof img.progress === 'number' ? img.progress : null;
        const iUrls = img.model_urls || {};
        if (iSt !== 'SUCCEEDED') {
            return res.json({ ok: true, phase: 'image', status: iSt === '?' ? null : iSt, progress: iPg == null ? null : Math.round(iPg * 0.5), model_url: null });
        }
        // Image done — start / find rigging
        let rigId = rigLinks[tid];
        if (!rigId && !rigStarting.has(tid)) {
            const glb = iUrls.glb;
            if (!glb) return res.json({ ok: true, phase: 'image', status: 'SUCCEEDED', progress: 100, model_url: null, task_error: 'no glb from Meshy' });
            rigStarting.add(tid);
            try {
                rigId = await meshyStartRig(tid, glb);
                rigLinks[tid] = rigId;
                log('status', 'rig kicked img=' + tid.slice(-6) + ' rig=' + rigId.slice(-6));
            } finally { rigStarting.delete(tid); }
        }
        if (!rigId) return res.json({ ok: true, phase: 'image', status: 'SUCCEEDED', progress: 50, model_url: null });

        const rig = await meshyGetRigStatus(rigId);
        const rSt = rig.status || '?';
        const rPg = typeof rig.progress === 'number' ? rig.progress : null;
        if (rSt === 'SUCCEEDED') {
            const rd = rig.result || {};
            const anim = rd.basic_animations || {};
            const model_url = (rd.rigged_character_glb_url) || anim.running_glb_url || anim.walking_glb_url || null;
            const fbx_url = rd.rigged_character_fbx_url || rd.fbx_url || (rd.model_urls && rd.model_urls.fbx) || null;
            if (fbx_url && !fbxHasLocal(rigId)) {
                fbxMirror(rigId, fbx_url).catch(e => log('status', 'fbx mirror fail ' + e.message));
            }
            return res.json({ ok: true, phase: 'rigging', status: 'SUCCEEDED', progress: 100, model_url, rig_task_id: rigId });
        }
        if (rSt === 'FAILED' || rSt === 'CANCELED') {
            return res.json({ ok: true, phase: 'rigging', status: rSt, progress: rPg, model_url: iUrls.glb || null, task_error: rig.task_error || rSt });
        }
        return res.json({ ok: true, phase: 'rigging', status: rSt === '?' ? null : rSt, progress: rPg == null ? 50 : (50 + Math.round(rPg * 0.5)), model_url: null, rig_task_id: rigId });
    } catch (err) {
        log('status', 'FAIL ' + err.message);
        res.status(502).json({ ok: false, error: err.message });
    }
});

// ─── Model proxy — dodges CORS on Meshy CDN ──────────────────────────
const ALLOWED_MODEL_HOSTS = /^https:\/\/(?:[a-z0-9-]+\.)*(?:meshy\.ai|amazonaws\.com|cloudfront\.net|googleapis\.com|googleusercontent\.com)\//i;
app.get('/modder/model', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url || !ALLOWED_MODEL_HOSTS.test(url)) return res.status(400).json({ ok: false, error: 'bad url' });
    try {
        const r = await axios.get(url, { responseType: 'stream', timeout: 30000 });
        res.set('Content-Type', r.headers['content-type'] || 'application/octet-stream');
        res.set('Cache-Control', 'public, max-age=300');
        r.data.pipe(res);
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ─── FBX download ────────────────────────────────────────────────────
app.get('/modder/fbx/:rigTaskId', async (req, res) => {
    const rigId = safeId(req.params.rigTaskId);
    if (!rigId) return res.status(400).json({ ok: false, error: 'bad rig id' });
    if (!fbxHasLocal(rigId) && MESHY_KEY) {
        try {
            const rig = await meshyGetRigStatus(rigId);
            if (rig.status === 'SUCCEEDED') {
                const rd = rig.result || {};
                const fbxUrl = rd.rigged_character_fbx_url || rd.fbx_url || (rd.model_urls && rd.model_urls.fbx) || null;
                if (fbxUrl) await fbxMirror(rigId, fbxUrl);
            }
        } catch (_) {}
    }
    if (!fbxHasLocal(rigId)) return res.status(404).json({ ok: false, error: 'FBX not available' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="char-' + rigId.slice(-8) + '.fbx"');
    res.set('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(fbxPath(rigId)).pipe(res);
});

// ─── Base .DAT upload ────────────────────────────────────────────────
app.post('/modder/base-dat', express.json({ limit: '8mb' }), (req, res) => {
    const b = req.body || {};
    const filename = safeFilename(b.filename || 'base.dat', 60);
    const b64 = String(b.data_b64 || '');
    if (!b64) return res.status(400).json({ ok: false, error: 'data_b64 required' });
    let buf;
    try { buf = Buffer.from(b64, 'base64'); }
    catch (_) { return res.status(400).json({ ok: false, error: 'bad base64' }); }
    if (buf.length < 512 || buf.length > 4 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'unexpected .DAT size ' + buf.length });
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
    const datId = 'dat-' + hash;
    const dst = path.join(dirs.baseDats, datId + '.dat');
    try {
        if (!fs.existsSync(dst)) fs.writeFileSync(dst, buf);
        fs.writeFileSync(path.join(dirs.baseDats, datId + '.meta.json'),
            JSON.stringify({ filename, size: buf.length, ts: Date.now() }, null, 2));
    } catch (e) { return res.status(500).json({ ok: false, error: 'save fail: ' + e.message }); }
    log('base-dat', 'saved id=' + datId + ' size=' + buf.length + ' name=' + filename);
    res.json({ ok: true, dat_id: datId, filename, size: buf.length });
});

// ─── Process ──────────────────────────────────────────────────────────
app.post('/modder/process/:rigTaskId', express.json({ limit: '32kb' }), (req, res) => {
    const rigId = safeId(req.params.rigTaskId);
    const datId = safeId((req.body && req.body.base_dat_id) || '');
    if (!rigId || !datId) return res.status(400).json({ ok: false, error: 'rig id + base_dat_id required' });
    if (!fbxHasLocal(rigId)) return res.status(404).json({ ok: false, error: 'no FBX cached for this rig' });
    const datPath = path.join(dirs.baseDats, datId + '.dat');
    if (!fs.existsSync(datPath)) {
        // Also try dev-fixtures
        const devPath = path.join(dirs.baseDats, 'dev-fixtures', datId + '.dat');
        if (!fs.existsSync(devPath)) return res.status(404).json({ ok: false, error: 'unknown base_dat_id' });
    }
    const effectiveDatPath = fs.existsSync(datPath) ? datPath : path.join(dirs.baseDats, 'dev-fixtures', datId + '.dat');

    const meshyFbxFile = fbxPath(rigId);
    const workDir = path.join(dirs.mods, 'work-' + rigId.slice(-8) + '-' + datId);
    fs.mkdirSync(workDir, { recursive: true });
    const outName = 'splice-' + rigId.slice(-8) + '-' + datId + '.fbx';
    const outPath = path.join(dirs.mods, outName);
    const falconDae = path.join(workDir, 'falcon.dae');

    log('process', 'rig=' + rigId.slice(-6) + ' dat=' + datId);

    function finishBlender(sourceRefPath) {
        runBlender(meshyFbxFile, sourceRefPath, outPath, (err, stdout, stderr) => {
            const spliceLog = (stdout + '\n' + stderr).split('\n').filter(l => /^\[splice\]/.test(l)).join('\n');
            if (err) return res.status(500).json({ ok: false, status: 'blender_failed', error: err.message, splice_log: spliceLog });
            if (!fs.existsSync(outPath)) return res.status(500).json({ ok: false, status: 'no_output', error: 'blender produced no output', splice_log: spliceLog });
            const size = fs.statSync(outPath).size;
            const refSource = sourceRefPath === falconDae ? 'real_falcon_dae' : 'proxy_rig';

            // Now hsdcli splice-mesh
            const datOutName = 'mod-' + rigId.slice(-8) + '-' + datId + '.dat';
            const datOutPath = path.join(dirs.mods, datOutName);
            runHsdcli(['splice-mesh', effectiveDatPath, outPath, datOutPath], (spliceErr, spliceStdout, spliceStderr) => {
                const cliLog = (spliceStdout + '\n' + spliceStderr).split('\n').filter(l => /\[splice-mesh\]|error/i.test(l)).join('\n');
                if (spliceErr || !fs.existsSync(datOutPath)) {
                    log('process', 'splice-mesh FAIL rig=' + rigId.slice(-6));
                    return res.json({
                        ok: true, status: 'fbx_ready_dat_failed',
                        message: 'Blender OK, HSDLib splice failed. Load the FBX in HSDRaw manually.',
                        rig_task_id: rigId, base_dat_id: datId, ref_source: refSource,
                        output_filename: outName, output_size: size,
                        download_path: '/modder/download/' + outName,
                        dat_error: spliceErr ? spliceErr.message : 'no output file',
                        cli_log: cliLog, splice_log: spliceLog,
                    });
                }
                const datSize = fs.statSync(datOutPath).size;
                log('process', 'rig=' + rigId.slice(-6) + ' DAT OK ' + datOutName + ' (' + datSize + 'B)');
                res.json({
                    ok: true, status: 'dat_ready',
                    message: 'Modded .DAT ready.',
                    rig_task_id: rigId, base_dat_id: datId, ref_source: refSource,
                    output_filename: datOutName, output_size: datSize,
                    download_path: '/modder/download/' + datOutName,
                    fbx_download_path: '/modder/download/' + outName,
                    cli_log: cliLog, splice_log: spliceLog,
                });
            });
        });
    }

    // Step A: extract-scene from base .DAT
    runHsdcli(['extract-scene', effectiveDatPath, falconDae], (sceneErr) => {
        if (!sceneErr && fs.existsSync(falconDae) && fs.statSync(falconDae).size > 1024) {
            log('process', 'extracted falcon.dae from ' + datId);
            return finishBlender(falconDae);
        }
        log('process', 'extract-scene fail ' + (sceneErr && sceneErr.message) + ' — falling back to proxy');
        // Proxy fallback: use the character's own FBX as reference (degenerate, but proves the pipeline)
        finishBlender(meshyFbxFile);
    });
});

// ─── Download ────────────────────────────────────────────────────────
app.get('/modder/download/:filename', (req, res) => {
    const name = safeFilename(req.params.filename);
    if (!/^(splice|mod)-[a-z0-9_-]+\.(fbx|dat)$/i.test(name)) return res.status(400).json({ ok: false, error: 'bad filename' });
    const p = path.join(dirs.mods, name);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'not found' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + name + '"');
    fs.createReadStream(p).pipe(res);
});

// ─── Dev endpoints (ISO + base-DAT seed) ─────────────────────────────
app.post('/modder/dev-iso', (req, res) => {
    const suggested = safeFilename(req.query.name || 'melee.iso', 60);
    const finalName = /\.(iso|rvz|gcz)$/i.test(suggested) ? suggested : suggested + '.iso';
    const dst = path.join(dirs.isos, finalName);
    const tmp = dst + '.uploading';
    const w = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha256');
    let received = 0;
    const startTs = Date.now();
    req.on('data', chunk => { received += chunk.length; hash.update(chunk); });
    req.on('end', () => {
        w.end();
        const sha = hash.digest('hex');
        try {
            fs.renameSync(tmp, dst);
            log('dev-iso', 'stored ' + finalName + ' ' + received + 'B sha=' + sha.slice(0, 12));
            res.json({ ok: true, filename: finalName, size: received, sha256: sha, path: dst, seconds: (Date.now() - startTs) / 1000 });
        } catch (e) { res.status(500).json({ ok: false, error: 'rename fail: ' + e.message }); }
    });
    req.on('error', err => {
        try { fs.unlinkSync(tmp); } catch (_) {}
        res.status(500).json({ ok: false, error: err.message });
    });
    req.pipe(w);
});

/*
 * POST /modder/dev-iso-from-url — server-side fetch of large ISOs.
 * body: { url: "https://drive.google.com/file/d/…/view" | "https://mega.nz/file/…#…" | any https url }
 * Streams the download to disk with progress logged to /modder/logs. Returns
 * once complete; frontend polls /modder/iso-status while it runs.
 *
 * Rationale: uploading a 1.4 GB Melee ISO from a mobile browser is fragile
 * (tab suspend, WiFi flips, session timeout). Server-to-server pulls from
 * Drive/Mega are steady 100+ Mbps and survive whatever the phone does.
 */
const isoJobs = {};   // jobId -> { status, received, total, ts, err, filename }
function newIsoJob() {
    const id = 'iso-' + crypto.randomBytes(6).toString('hex');
    isoJobs[id] = { status: 'starting', received: 0, total: 0, ts: Date.now(), err: null, filename: null };
    return id;
}
function extractDriveId(url) {
    const m = /\/file\/d\/([A-Za-z0-9_-]{20,})/.exec(url) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(url);
    return m ? m[1] : null;
}
function driveDirectUrl(id) {
    return 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(id) + '&export=download&confirm=t';
}
function isMegaUrl(url) {
    return /^https?:\/\/(www\.)?mega\.(nz|co\.nz)\/file\//.test(url);
}
app.post('/modder/dev-iso-from-url', express.json({ limit: '4kb' }), (req, res) => {
    const url = String((req.body && req.body.url) || '').trim();
    if (!/^https:\/\//.test(url)) return res.status(400).json({ ok: false, error: 'https url required' });

    const jobId = newIsoJob();
    const startTs = Date.now();
    const suggested = safeFilename((req.body && req.body.name) || 'melee.iso', 60);
    const finalName = /\.(iso|rvz|gcz)$/i.test(suggested) ? suggested : suggested + '.iso';
    let dst = path.join(dirs.isos, finalName);
    const tmp = dst + '.downloading';
    isoJobs[jobId].filename = finalName;

    log('iso-fetch', 'job=' + jobId + ' url=' + url.slice(0, 80));
    res.json({ ok: true, job_id: jobId, filename: finalName, url: url.slice(0, 200) });

    // --- Path A: Mega — shell out to megadl which handles E2E key from URL fragment.
    if (isMegaUrl(url)) {
        isoJobs[jobId].status = 'downloading';
        const megadl = require('child_process').spawn('megadl', ['--path=' + dirs.isos, url], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        megadl.stderr.on('data', d => { stderr += d.toString(); });
        megadl.stdout.on('data', d => {
            const m = /(\d+\.\d+)%/.exec(d.toString());
            if (m) { isoJobs[jobId].received = parseFloat(m[1]); }
        });
        megadl.on('close', code => {
            if (code !== 0) {
                isoJobs[jobId].status = 'error';
                isoJobs[jobId].err = 'megadl exit ' + code + ' ' + stderr.slice(-200);
                log('iso-fetch', 'job=' + jobId + ' megadl FAIL ' + stderr.slice(-200));
                return;
            }
            // megadl saves with the original filename; find newest .iso/.rvz/.gcz/.dat in dirs.isos
            const entries = fs.readdirSync(dirs.isos).filter(n => !n.endsWith('.downloading'))
                .map(n => ({ n, m: fs.statSync(path.join(dirs.isos, n)).mtimeMs })).sort((a,b) => b.m - a.m);
            const newest = entries[0];
            const sz = newest ? fs.statSync(path.join(dirs.isos, newest.n)).size : 0;
            isoJobs[jobId].status = 'done';
            isoJobs[jobId].received = sz;
            isoJobs[jobId].total = sz;
            isoJobs[jobId].filename = newest ? newest.n : finalName;
            log('iso-fetch', 'job=' + jobId + ' megadl OK ' + (newest && newest.n) + ' ' + sz + 'B in ' + ((Date.now() - startTs)/1000).toFixed(1) + 's');
        });
        return;
    }

    // --- Path B: Drive or arbitrary HTTPS URL — use axios stream to disk.
    const fetchUrl = (() => {
        const gid = /drive\.google\.com/.test(url) ? extractDriveId(url) : null;
        return gid ? driveDirectUrl(gid) : url;
    })();
    isoJobs[jobId].status = 'downloading';
    axios.get(fetchUrl, { responseType: 'stream', maxRedirects: 10, timeout: 0 }).then(r => {
        const total = parseInt(r.headers['content-length'] || '0', 10) || 0;
        isoJobs[jobId].total = total;
        // If Drive gave us a filename via Content-Disposition, prefer it
        const cd = r.headers['content-disposition'] || '';
        const cdm = /filename="([^"]+)"/.exec(cd);
        if (cdm) {
            const safe = safeFilename(cdm[1], 80);
            if (/\.(iso|rvz|gcz)$/i.test(safe)) {
                dst = path.join(dirs.isos, safe);
                isoJobs[jobId].filename = safe;
            }
        }
        const w = fs.createWriteStream(tmp);
        let received = 0;
        let lastLog = 0;
        r.data.on('data', chunk => {
            received += chunk.length;
            isoJobs[jobId].received = received;
            if (Date.now() - lastLog > 5000) {
                lastLog = Date.now();
                const pct = total ? Math.round(received/total*100) : 0;
                log('iso-fetch', 'job=' + jobId + ' ' + pct + '% ' + Math.round(received/1e6) + '/' + Math.round(total/1e6) + ' MB');
            }
        });
        r.data.on('error', e => {
            isoJobs[jobId].status = 'error';
            isoJobs[jobId].err = e.message;
            try { fs.unlinkSync(tmp); } catch (_) {}
            log('iso-fetch', 'job=' + jobId + ' STREAM ERR ' + e.message);
        });
        r.data.pipe(w);
        w.on('close', () => {
            if (isoJobs[jobId].status === 'error') return;
            try {
                fs.renameSync(tmp, dst);
                isoJobs[jobId].status = 'done';
                isoJobs[jobId].filename = path.basename(dst);
                log('iso-fetch', 'job=' + jobId + ' OK ' + path.basename(dst) + ' ' + received + 'B in ' + ((Date.now() - startTs)/1000).toFixed(1) + 's');
            } catch (e) {
                isoJobs[jobId].status = 'error';
                isoJobs[jobId].err = 'rename fail: ' + e.message;
                log('iso-fetch', 'job=' + jobId + ' RENAME FAIL ' + e.message);
            }
        });
    }).catch(e => {
        isoJobs[jobId].status = 'error';
        isoJobs[jobId].err = e.message;
        try { fs.unlinkSync(tmp); } catch (_) {}
        log('iso-fetch', 'job=' + jobId + ' AXIOS FAIL ' + e.message);
    });
});
app.get('/modder/dev-iso-from-url/:jobId', (req, res) => {
    const j = isoJobs[safeId(req.params.jobId)];
    if (!j) return res.status(404).json({ ok: false, error: 'unknown job' });
    res.json({ ok: true, job: j });
});

app.post('/modder/dev-fixture', express.json({ limit: '8mb' }), (req, res) => {
    const b = req.body || {};
    const rawName = safeFilename(b.filename || 'fixture.dat', 60);
    const filename = /\.dat$/i.test(rawName) ? rawName : rawName + '.dat';
    let buf;
    try { buf = Buffer.from(String(b.data_b64 || ''), 'base64'); }
    catch (_) { return res.status(400).json({ ok: false, error: 'bad base64' }); }
    if (buf.length < 512 || buf.length > 4 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'unexpected .DAT size ' + buf.length });
    const dir = path.join(dirs.baseDats, 'dev-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, filename);
    try {
        fs.writeFileSync(dst, buf);
        const meta = {
            filename, size: buf.length, path: dst,
            sha256: crypto.createHash('sha256').update(buf).digest('hex'),
            magic_hex: buf.slice(0, 16).toString('hex'),
            header_be: {
                file_size:    buf.readUInt32BE(0),
                reloc_offset: buf.readUInt32BE(4),
                reloc_count:  buf.readUInt32BE(8),
                root_count:   buf.readUInt32BE(12),
                ref_count:    buf.readUInt32BE(16),
            },
            ts: Date.now(),
        };
        fs.writeFileSync(dst + '.meta.json', JSON.stringify(meta, null, 2));
        log('dev-fixture', filename + ' seeded size=' + buf.length);
        res.json(Object.assign({ ok: true }, meta));
    } catch (e) { res.status(500).json({ ok: false, error: 'save fail: ' + e.message }); }
});

// ─── UnclePunch Training Mode builder + in-Melee screenshot loop ─────
// UnclePunch v3.0-Alpha7.2 ships as an xdelta patch (~7 MB) that turns
// a clean vanilla NTSC 1.02 ISO into TM.iso. No compilation needed.
// The patch expects the vanilla ISO to have MD5 = 0e63d4223b01d9aba596259dc155a174.
const TM_PATCH        = process.env.TM_PATCH || '/opt/tm-release/Training Mode 3.0 Alpha7.2/TM ISO Builder/patch.xdelta';
const TM_VANILLA_MD5  = '0e63d4223b01d9aba596259dc155a174';
const TM_ISO_PATH     = path.join(dirs.isos, 'melee_TM.iso');
const TM_META_PATH    = path.join(dirs.state, 'tm-build.json');
const XDELTA3         = process.env.XDELTA3 || '/usr/bin/xdelta3';
const WIT             = process.env.WIT     || '/usr/bin/wit';
const DOLPHIN         = process.env.DOLPHIN || '/usr/local/bin/dolphin-emu-nogui';
const XVFB_RUN        = process.env.XVFB_RUN || '/usr/bin/xvfb-run';
const FFMPEG          = process.env.FFMPEG  || '/usr/bin/ffmpeg';

// Vanilla-ISO detection. Users upload their own copy; the file lives at
// isos/<something>.iso (not necessarily named "vanilla"). We pick the largest
// .iso that isn't melee_TM.iso and md5 it.
function findVanillaIso(cb) {
    let candidates;
    try {
        candidates = fs.readdirSync(dirs.isos)
            .filter(n => /\.(iso|rvz|gcz)$/i.test(n) && n !== path.basename(TM_ISO_PATH))
            .map(n => ({ n, p: path.join(dirs.isos, n), size: fs.statSync(path.join(dirs.isos, n)).size }))
            .sort((a, b) => b.size - a.size);
    } catch (e) { return cb(e); }
    if (!candidates.length) return cb(new Error('no ISO uploaded'));
    // Only .iso is patchable by the xdelta patch (rvz/gcz are compressed)
    const iso = candidates.find(c => /\.iso$/i.test(c.n));
    if (!iso) return cb(new Error('found ' + candidates[0].n + ' but xdelta needs raw .iso, not rvz/gcz'));
    cb(null, iso);
}
function md5File(p, cb) {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(p);
    s.on('data', c => h.update(c));
    s.on('end', () => cb(null, h.digest('hex')));
    s.on('error', cb);
}

// POST /modder/build-tm-iso — one-shot, safe to call repeatedly (idempotent
// if TM.iso already exists and vanilla ISO is unchanged). Response is quick:
// returns a job_id, actual patch runs async and is polled via GET.
const tmJobs = {};   // jobId -> { status, err, elapsed_s, tm_size, source_md5 }
app.post('/modder/build-tm-iso', (req, res) => {
    if (!fs.existsSync(TM_PATCH)) return res.status(500).json({ ok: false, error: 'TM patch missing at ' + TM_PATCH });
    if (!fs.existsSync(XDELTA3))  return res.status(500).json({ ok: false, error: 'xdelta3 not installed' });
    findVanillaIso((err, iso) => {
        if (err) return res.status(400).json({ ok: false, error: err.message });
        const jobId = 'tm-' + crypto.randomBytes(6).toString('hex');
        tmJobs[jobId] = { status: 'md5', source: iso.n, ts: Date.now() };
        res.json({ ok: true, job_id: jobId, source: iso.n, source_size: iso.size });

        md5File(iso.p, (mErr, md5) => {
            if (mErr) { tmJobs[jobId].status = 'error'; tmJobs[jobId].err = 'md5 fail: ' + mErr.message; return; }
            tmJobs[jobId].source_md5 = md5;
            if (md5 !== TM_VANILLA_MD5) {
                tmJobs[jobId].status = 'error';
                tmJobs[jobId].err = 'ISO MD5 ' + md5 + ' does not match expected ' + TM_VANILLA_MD5 +
                    ' — you need vanilla NTSC 1.02 (Tournament Standard). Yours might be v1.00, v1.01, PAL, or already modded.';
                log('tm-build', 'job=' + jobId + ' MD5 MISMATCH ' + md5);
                return;
            }
            log('tm-build', 'job=' + jobId + ' MD5 ok, starting xdelta3');
            tmJobs[jobId].status = 'patching';
            const start = Date.now();
            const tmpOut = TM_ISO_PATH + '.building';
            try { fs.unlinkSync(tmpOut); } catch (_) {}
            const proc = require('child_process').spawn(XDELTA3,
                ['-dfs', iso.p, TM_PATCH, tmpOut],
                { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('close', code => {
                const elapsed = ((Date.now() - start) / 1000).toFixed(1);
                if (code !== 0 || !fs.existsSync(tmpOut)) {
                    tmJobs[jobId].status = 'error';
                    tmJobs[jobId].err = 'xdelta3 exit ' + code + ' ' + stderr.slice(-300);
                    try { fs.unlinkSync(tmpOut); } catch (_) {}
                    log('tm-build', 'job=' + jobId + ' PATCH FAIL ' + stderr.slice(-200));
                    return;
                }
                try { fs.renameSync(tmpOut, TM_ISO_PATH); } catch (e) {
                    tmJobs[jobId].status = 'error';
                    tmJobs[jobId].err = 'rename: ' + e.message; return;
                }
                const size = fs.statSync(TM_ISO_PATH).size;
                tmJobs[jobId].status = 'done';
                tmJobs[jobId].elapsed_s = parseFloat(elapsed);
                tmJobs[jobId].tm_size = size;
                fs.writeFileSync(TM_META_PATH, JSON.stringify({
                    built_at: new Date().toISOString(),
                    source_iso: iso.n, source_md5: md5,
                    tm_iso: TM_ISO_PATH, tm_size: size,
                    elapsed_s: parseFloat(elapsed),
                }, null, 2));
                log('tm-build', 'job=' + jobId + ' DONE ' + size + 'B in ' + elapsed + 's');
            });
        });
    });
});
app.get('/modder/build-tm-iso/:jobId', (req, res) => {
    const j = tmJobs[safeId(req.params.jobId)];
    if (!j) return res.status(404).json({ ok: false, error: 'unknown job' });
    res.json({ ok: true, job: j, tm_iso_exists: fs.existsSync(TM_ISO_PATH), tm_iso_size: fs.existsSync(TM_ISO_PATH) ? fs.statSync(TM_ISO_PATH).size : 0 });
});
app.get('/modder/tm-status', (req, res) => {
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(TM_META_PATH, 'utf8')); } catch (_) {}
    res.json({ ok: true, tm_iso_exists: fs.existsSync(TM_ISO_PATH),
        tm_iso_size: fs.existsSync(TM_ISO_PATH) ? fs.statSync(TM_ISO_PATH).size : 0,
        meta: meta });
});

// POST /modder/test-in-melee/:modFilename — inject a mod .DAT into TM.iso,
// boot Dolphin under xvfb, capture 3 screenshots ~3s apart via ffmpeg x11grab,
// return public URLs. body: { char_slot: "PlCaNr" }  (which vanilla character
// file to overwrite — defaults to PlCaNr = Falcon neutral costume).
const testJobs = {};
app.post('/modder/test-in-melee/:modFilename', express.json({ limit: '4kb' }), (req, res) => {
    const modName = safeFilename(req.params.modFilename);
    if (!/^mod-[a-z0-9_-]+\.dat$/i.test(modName)) return res.status(400).json({ ok: false, error: 'bad mod filename' });
    const modPath = path.join(dirs.mods, modName);
    if (!fs.existsSync(modPath)) return res.status(404).json({ ok: false, error: 'mod file not found' });
    if (!fs.existsSync(TM_ISO_PATH)) return res.status(400).json({ ok: false, error: 'TM.iso not built yet; POST /modder/build-tm-iso first' });
    const charSlot = safeId((req.body && req.body.char_slot) || 'PlCaNr', 12);
    if (!/^[A-Z][a-z][A-Z][a-z][A-Z][a-z]$/.test(charSlot) && charSlot !== 'PlCaNr') {
        // Loose validation — Melee char files are e.g. PlCaNr, PlFxRe, PlKbGr
        // Accept anything that at least starts with Pl and is 4-8 chars
        if (!/^Pl[A-Z][a-z][A-Za-z]{0,4}$/.test(charSlot)) {
            return res.status(400).json({ ok: false, error: 'bad char_slot (expected e.g. PlCaNr for Falcon neutral)' });
        }
    }

    const jobId = 'match-' + crypto.randomBytes(6).toString('hex');
    testJobs[jobId] = { status: 'starting', ts: Date.now(), mod: modName, char_slot: charSlot };
    res.json({ ok: true, job_id: jobId, mod: modName, char_slot: charSlot });

    // workDir sits under dirs.mods so it's already served via /public/mods
    const workDir = path.join(dirs.mods, jobId);
    fs.mkdirSync(workDir, { recursive: true });
    const patchedIso = path.join(workDir, 'melee_TM_patched.iso');
    const shotDir    = path.join(workDir, 'shots');
    fs.mkdirSync(shotDir, { recursive: true });

    // Step 1: direct GameCube FST patch — copies TM.iso and rewrites the
    // <charSlot>.dat entry in place. wit's EXTRACT+COPY rebuild silently
    // produces Wii-format output on GC discs, so we bypass it with a
    // small Python helper that parses the FST directly.
    log('test-in-melee', 'job=' + jobId + ' step=gc-patch slot=' + charSlot);
    testJobs[jobId].status = 'patching-iso';
    const { execFile, spawn } = require('child_process');
    const GC_PATCH = process.env.GC_PATCH || '/opt/modder-tools/gc-patch.py';
    execFile('python3', [GC_PATCH, TM_ISO_PATH, patchedIso, charSlot + '.dat', modPath],
        { timeout: 120000, maxBuffer: 8*1024*1024 },
        (pErr, pOut, pStderr) => {
            if (pErr || !fs.existsSync(patchedIso)) {
                testJobs[jobId].status = 'error';
                testJobs[jobId].err = 'gc-patch: ' + (pErr && pErr.message) + ' ' + pStderr;
                log('test-in-melee', 'job=' + jobId + ' PATCH FAIL ' + pStderr);
                return;
            }
            log('test-in-melee', 'job=' + jobId + ' gc-patch OK: ' + (pOut.trim().split('\n').slice(-1)[0]));
            runDolphinAndShoot();
        });

    function runDolphinAndShoot() {
        testJobs[jobId].status = 'booting-dolphin';
        log('test-in-melee', 'job=' + jobId + ' step=xvfb+dolphin boot');
        // Per-job display :60..:79. Xvfb directly (not xvfb-run) so we can
        // -ac disable auth and ffmpeg can grab without XAUTHORITY wrangling.
        const displayN = 60 + Math.floor(Math.random() * 20);
        const displayArg = ':' + displayN;
        try { fs.unlinkSync('/tmp/.X' + displayN + '-lock'); } catch (_) {}
        // Pipe for scripted GameCube controller input (advance menus)
        const pipesDir = '/root/.local/share/dolphin-emu/Pipes';
        fs.mkdirSync(pipesDir, { recursive: true });
        const pipePath = path.join(pipesDir, 'p1');
        try { fs.unlinkSync(pipePath); } catch (_) {}
        require('child_process').execSync('mkfifo ' + pipePath);

        const xvfb = spawn('Xvfb', [displayArg, '-screen', '0', '800x600x24', '-ac', '+extension', 'GLX', '+extension', 'RANDR'],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        xvfb.stderr.on('data', d => log('test-in-melee', 'job=' + jobId + ' xvfb: ' + d.toString().trim().slice(0, 120)));

        setTimeout(() => {
            // LD_PRELOAD our shim so shm_open -> memfd_create (works around
            // Docker's 64 MB /dev/shm cap that would SIGBUS Dolphin's arena).
            const dolEnv = Object.assign({}, process.env, {
                DISPLAY: displayArg,
                LD_PRELOAD: '/opt/modder-tools/shm_to_memfd.so',
            });
            const dol = spawn(DOLPHIN, ['-p', 'x11', '-v', 'Software', '-e', patchedIso],
                { stdio: ['ignore', 'pipe', 'pipe'], env: dolEnv });
            dol.stderr.on('data', d => {
                const s = d.toString().trim();
                if (s && !/^ALSA lib|snd_/i.test(s)) log('test-in-melee', 'job=' + jobId + ' dolphin: ' + s.slice(0, 200));
            });
            dol.on('exit', code => log('test-in-melee', 'job=' + jobId + ' dolphin exit ' + code));

            const cleanup = () => {
                try { dol.kill('SIGTERM'); } catch (_) {}
                setTimeout(() => { try { dol.kill('SIGKILL'); } catch (_) {} }, 2000);
                setTimeout(() => { try { xvfb.kill('SIGKILL'); } catch (_) {} }, 3000);
                setTimeout(() => { try { fs.unlinkSync(pipePath); } catch (_) {} }, 4000);
            };

            // 5s in: reposition dolphin window to (0,0) so ffmpeg's 800x600 grab
            // captures the whole render. xdotool -sync waits for the event.
            setTimeout(() => {
                try {
                    const { execSync } = require('child_process');
                    const wid = execSync('DISPLAY=' + displayArg + ' xdotool search --name "Dolphin" | head -1',
                        { encoding: 'utf8' }).trim();
                    if (/^\d+$/.test(wid)) {
                        execSync('DISPLAY=' + displayArg + ' xdotool windowmove ' + wid + ' 0 0');
                        execSync('DISPLAY=' + displayArg + ' xdotool windowsize ' + wid + ' 800 600');
                        log('test-in-melee', 'job=' + jobId + ' window ' + wid + ' repositioned');
                    }
                } catch (e) { log('test-in-melee', 'job=' + jobId + ' xdotool skip: ' + e.message.slice(0, 100)); }
            }, 5000);

            // 6s in: feed input to dismiss memcard dialogs (A x3) so game reaches
            // the CSS or attract-mode gameplay. Extra A presses are harmless.
            setTimeout(() => {
                testJobs[jobId].status = 'sending-input';
                const script =
                    'PRESS A\nRELEASE A\n' +
                    // 4 more As for possible subsequent dialogs
                    (['PRESS A\nRELEASE A\n'].join('').repeat(0)) +
                    'PRESS A\nRELEASE A\n' +
                    'PRESS A\nRELEASE A\n' +
                    'PRESS A\nRELEASE A\n';
                // Write to pipe non-blocking. Use fs.createWriteStream so partial writes are OK.
                try {
                    const w = fs.createWriteStream(pipePath, { flags: 'a' });
                    // Space out button presses ~1s apart
                    const buttons = ['A','A','A','A'];
                    let i = 0;
                    const next = () => {
                        if (i >= buttons.length) { try { w.end(); } catch(_){} return; }
                        try {
                            w.write('PRESS ' + buttons[i] + '\n');
                            setTimeout(() => { try { w.write('RELEASE ' + buttons[i] + '\n'); } catch(_){} i++; setTimeout(next, 1200); }, 150);
                        } catch(_) {}
                    };
                    next();
                } catch (e) { log('test-in-melee', 'job=' + jobId + ' pipe write err: ' + e.message); }
            }, 6000);

            // Capture 3 shots ~3s apart, starting after game has time to advance
            // through dialogs. Because attract-mode timing is game-driven, later
            // shots may catch demo gameplay.
            const startAt = parseInt((req.body && req.body.capture_start_s) || 12, 10);
            const shotIntervalS = parseInt((req.body && req.body.capture_interval_s) || 3, 10);
            const shotCount = parseInt((req.body && req.body.capture_count) || 3, 10);

            setTimeout(() => {
                testJobs[jobId].status = 'capturing';
                const shots = [];
                const grabOne = (i, cb) => {
                    const out = path.join(shotDir, 'shot-' + (i+1) + '.png');
                    execFile(FFMPEG, ['-y', '-loglevel', 'error',
                        '-f', 'x11grab', '-video_size', '800x600', '-i', displayArg,
                        '-frames:v', '1', '-update', '1', out],
                        { timeout: 15000, env: Object.assign({}, process.env, { DISPLAY: displayArg }) },
                        (fErr, fOut, fStderr) => {
                            if (!fErr && fs.existsSync(out) && fs.statSync(out).size > 500) {
                                shots.push(out);
                                log('test-in-melee', 'job=' + jobId + ' shot ' + (i+1) + ' captured ' + fs.statSync(out).size + 'B');
                            } else {
                                log('test-in-melee', 'job=' + jobId + ' shot ' + (i+1) + ' FAIL ' + (fErr && fErr.message));
                            }
                            cb();
                        });
                };
                const grabAll = (i) => {
                    if (i >= shotCount) {
                        cleanup();
                        testJobs[jobId].status = 'done';
                        testJobs[jobId].shot_urls = shots.map(s =>
                            (CFG.publicBase.replace(/\/$/, '')) + '/public/mods/' + jobId + '/shots/' + path.basename(s));
                        log('test-in-melee', 'job=' + jobId + ' DONE ' + shots.length + ' shots');
                        return;
                    }
                    grabOne(i, () => setTimeout(() => grabAll(i+1), shotIntervalS * 1000));
                };
                grabAll(0);
            }, startAt * 1000);

            // Safety kill in case Dolphin hangs
            setTimeout(cleanup, 90000);
        }, 1500);
    }
});
app.get('/modder/test-in-melee/:jobId', (req, res) => {
    const j = testJobs[safeId(req.params.jobId)];
    if (!j) return res.status(404).json({ ok: false, error: 'unknown job' });
    res.json({ ok: true, job: j });
});

// ─── Logs + health ───────────────────────────────────────────────────
app.get('/modder/logs', (req, res) => {
    const n = Math.max(1, Math.min(LOG_MAX, parseInt(req.query.limit || '200', 10)));
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(ringBuf.slice(-n).join('\n') + '\n');
});
app.post('/modder/frontlog', express.json({ limit: '32kb' }), (req, res) => {
    const raw = String((req.body && req.body.msg) || '').slice(0, 800);
    if (raw) log('front', raw);
    res.json({ ok: true });
});
app.get('/modder/health', (req, res) => {
    res.json({
        ok: true,
        version: '0.1.0',
        meshy_key: !!MESHY_KEY,
        gemini_key: !!GEMINI_KEY,
        blender_bin: fs.existsSync(CFG.blender),
        blender_script: fs.existsSync(CFG.blenderScript),
        hsdcli_dll: fs.existsSync(CFG.hsdcliDll),
        dotnet: fs.existsSync(CFG.dotnet),
        storage_root: CFG.storageRoot,
        promo_codes_loaded: Object.keys(promoAllowlist).length,
    });
});

// Lets the frontend know whether an ISO has been uploaded (so it can
// paint the setup callout). Returns list summaries, not paths.
app.get('/modder/iso-status', (req, res) => {
    try {
        const entries = fs.readdirSync(dirs.isos)
            .filter(n => /\.(iso|rvz|gcz)$/i.test(n))
            .map(n => {
                const st = fs.statSync(path.join(dirs.isos, n));
                return { name: n, size: st.size, mtime: st.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
        res.json({ ok: true, count: entries.length, isos: entries.slice(0, 20) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// List everything the test-in-melee pipeline can consume — rigs, base .DATs,
// mods on disk — so the frontend can offer choices and I can drive it via curl.
app.get('/modder/inventory', (req, res) => {
    try {
        const rigs = fs.readdirSync(dirs.fbx).filter(n => n.endsWith('.fbx')).map(n => {
            const st = fs.statSync(path.join(dirs.fbx, n));
            return { rig_id: n.replace(/\.fbx$/, ''), size: st.size, mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime);
        const bases = fs.readdirSync(dirs.baseDats).filter(n => /^dat-.+\.dat$/.test(n)).map(n => {
            const id = n.replace(/\.dat$/, '');
            const meta = path.join(dirs.baseDats, id + '.meta.json');
            let m = null;
            try { m = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch (_) {}
            const st = fs.statSync(path.join(dirs.baseDats, n));
            return { dat_id: id, size: st.size, filename: (m && m.filename) || null };
        });
        let fixtures = [];
        try {
            fixtures = fs.readdirSync(path.join(dirs.baseDats, 'dev-fixtures'))
                .filter(n => n.endsWith('.dat')).map(n => ({ name: n }));
        } catch (_) {}
        const mods = fs.readdirSync(dirs.mods).filter(n => n.startsWith('mod-') && n.endsWith('.dat')).map(n => {
            const st = fs.statSync(path.join(dirs.mods, n));
            return { name: n, size: st.size, mtime: st.mtimeMs, download_path: '/modder/download/' + n };
        }).sort((a, b) => b.mtime - a.mtime);
        res.json({ ok: true, rigs, bases, fixtures, mods });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Non-consuming promo check for the frontend. Body: { code }
// Response: { ok: true, remaining: N } or { ok: false, remaining: 0, error }
app.post('/modder/promo/check', express.json({ limit: '2kb' }), (req, res) => {
    const code = (req.body && req.body.code) || '';
    const rem = promoRemaining(code);
    if (rem === null) return res.json({ ok: false, remaining: 0, error: 'invalid' });
    if (rem <= 0)     return res.json({ ok: false, remaining: 0, error: 'exhausted' });
    res.json({ ok: true, remaining: rem });
});

// ─── Start ───────────────────────────────────────────────────────────
const server = app.listen(CFG.port, '127.0.0.1', () => {
    log('boot', 'modder.js listening on 127.0.0.1:' + CFG.port
        + ' meshy_key=' + !!MESHY_KEY + ' gemini_key=' + !!GEMINI_KEY
        + ' storage=' + CFG.storageRoot);
});
server.setTimeout(30 * 60 * 1000);   // 30 min — accommodates 1+ GB ISO uploads
