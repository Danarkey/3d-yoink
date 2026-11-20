import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {convert} from './convert.mjs';

const run = promisify(execFile);
const port = Number(process.env.YOINK_PORT || 8787);
const expectedOrigin = `http://127.0.0.1:${port}`;
const blenderScript = fileURLToPath(new URL('./fbx_to_glb.py', import.meta.url));
let busy = false;
const page = await fs.readFile(new URL('./index.html', import.meta.url));

// ── Blender detection ──────────────────────────────────────────
let blenderPath = process.env.BLENDER_PATH;
if (!blenderPath) {
  for (const p of ['/Applications/Blender.app/Contents/MacOS/Blender', 'blender']) {
    try { await fs.access(p); blenderPath = p; break; } catch {}
  }
}

// ── Helpers ────────────────────────────────────────────────────

/** Download a URL to a Buffer. Host must be *.tripo3d.com. */
async function downloadModel(url, maxBytes = 150 * 1024 * 1024) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !u.hostname.endsWith('.tripo3d.com'))
    throw Error('Invalid model host.');
  const r = await fetch(url, {signal: AbortSignal.timeout(120000)});
  if (!r.ok) throw Error(`Download failed (HTTP ${r.status}). The signed URL may have expired — reload the Tripo page and yoink again.`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > maxBytes) throw Error('File exceeds 150 MB.');
  return bytes;
}

/** Parse an FBX binary to find RelativeFilename texture references. */
function findFbxTextureRefs(fbxBytes) {
  const text = new TextDecoder('utf-8', {fatal: false}).decode(fbxBytes);
  const refs = new Set();
  let idx = 0;
  while (true) {
    const pos = text.indexOf('RelativeFilename', idx);
    if (pos === -1) break;
    const chunk = text.slice(pos + 16, pos + 400);
    const match = chunk.match(/([A-Za-z0-9_\-\.]+\.fbm\/[A-Za-z0-9_\-\.]+)/);
    if (match) refs.add(match[1]);
    idx = pos + 20;
  }
  return [...refs];
}

/** Convert FBX → GLB via Blender, with textures placed alongside. */
async function convertFbxWithBlender(fbxBytes, textureFiles) {
  if (!blenderPath) throw Error('Blender not found. Install Blender or set BLENDER_PATH. Without Blender, only GLB Tripo models are supported.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoink-'));
  try {
    const fbxPath = path.join(dir, 'model.fbx');
    const glbPath = path.join(dir, 'model.glb');
    await fs.writeFile(fbxPath, fbxBytes);

    // Write texture files alongside the FBX
    for (const {relativePath, bytes} of textureFiles) {
      const texPath = path.join(dir, relativePath);
      await fs.mkdir(path.dirname(texPath), {recursive: true});
      await fs.writeFile(texPath, bytes);
    }

    try {
      await run(blenderPath, [
        '--background', '--factory-startup', '--disable-autoexec',
        '--python-exit-code', '1',
        '--python', blenderScript,
        '--', fbxPath, glbPath,
      ], {timeout: 300000, maxBuffer: 4 * 1024 * 1024});
    } catch (e) {
      if (e.code === 'ENOENT') throw Error('Blender not found at ' + blenderPath);
      throw Error('FBX conversion failed: ' + (e.stderr || e.stdout || e.message).slice(-500));
    }

    const result = await fs.readFile(glbPath);
    if (result.toString('ascii', 0, 4) !== 'glTF') throw Error('Blender did not produce a valid GLB.');
    return result;
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

// ── Server ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page);
    return;
  }

  if (req.method !== 'POST' || !['/convert', '/convert-tripo'].includes(req.url)) {
    res.writeHead(404); res.end(); return;
  }
  if (req.headers.origin !== expectedOrigin) { res.writeHead(403); res.end(); return; }
  if (busy) { res.writeHead(409); res.end('A conversion is already running.'); return; }

  busy = true;
  try {
    if (req.url === '/convert-tripo') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) throw Error('Request too large'); }
      const {url, title} = JSON.parse(body);
      const modelBytes = await downloadModel(url);
      const u = new URL(url);
      const ext = u.pathname.match(/\.(fbx|glb)$/i)?.[1]?.toLowerCase() || 'bin';
      const safeName = (title || 'tripo-model').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);

      let glbBytes;
      if (ext === 'glb' || (modelBytes.length >= 4 && modelBytes.toString('ascii', 0, 4) === 'glTF')) {
        // Already GLB — pass through
        glbBytes = modelBytes;
      } else {
        // FBX — download textures from same CDN directory, then convert with Blender
        const texRefs = findFbxTextureRefs(modelBytes);
        const baseDir = u.origin + u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
        const sigParams = u.search; // CloudFront signing — same policy often covers the directory

        const textureFiles = [];
        for (const relPath of texRefs) {
          const texUrl = baseDir + relPath + sigParams;
          try {
            const texBytes = await downloadModel(texUrl);
            textureFiles.push({relativePath: relPath, bytes: texBytes});
          } catch (e) {
            console.warn(`Could not download texture ${relPath}: ${e.message}`);
          }
        }
        console.log(`FBX conversion: ${texRefs.length} texture(s) referenced, ${textureFiles.length} downloaded`);
        glbBytes = await convertFbxWithBlender(modelBytes, textureFiles);
      }

      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Content-Disposition': `attachment; filename="${safeName}.glb"`,
      });
      res.end(glbBytes);
      return;
    }

    // Meshy convert
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) throw Error('Request too large'); }
    const result = await convert(JSON.parse(body).url);
    res.writeHead(200, {
      'Content-Type': 'model/gltf-binary',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'X-Model-License': result.metadata.license || 'unspecified',
    });
    res.end(result.bytes);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(400, {'Content-Type': 'text/plain; charset=utf-8'});
      res.end(e.message);
    }
  } finally { busy = false; }
});

server.on('error', e => { console.error(e.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => {
  console.log(`3D Yoink running at ${expectedOrigin}`);
  console.log(`Blender: ${blenderPath || 'not found (FBX conversion disabled)'}`);
});
