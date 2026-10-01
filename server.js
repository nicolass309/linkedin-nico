const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Database File Paths
const DB_FILE = path.join(__dirname, 'posts.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Composio API Production Credentials (LinkedIn Direct Channel)
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || 'ck_fOOHj9n4RVFhTNEED0jO';
// Strictly enforce correct person URN for Nicolás Peña Diaz (-4DFGTk-xF), ignoring any stale 800423380 env var
let LINKEDIN_PERSON_URN = 'urn:li:person:-4DFGTk-xF';
if (process.env.LINKEDIN_PERSON_URN && !process.env.LINKEDIN_PERSON_URN.includes('800423380')) {
  LINKEDIN_PERSON_URN = process.env.LINKEDIN_PERSON_URN;
}

// GitHub Sync Secrets (Optional for persistent automatic commits on Render)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'nicolass309/linkedin-nico';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// Helper to calculate unique content signature (for deduplication)
function getPostSignature(title, text) {
  const normalized = `${(title || '').trim().toLowerCase()}|||${(text || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Helper to push database changes directly to GitHub (Solves Render ephemeral container disk wipes)
async function syncToGitHub(postsData, commitMessage = 'Auto-sync database from LinkedIn App') {
  if (!GITHUB_TOKEN) {
    return false;
  }

  return new Promise((resolve) => {
    try {
      const getOptions = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/posts.json?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: {
          'User-Agent': 'LinkedIn-AutoPoster',
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      };

      const getReq = https.request(getOptions, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          let sha = '';
          try {
            const parsed = JSON.parse(body);
            sha = parsed.sha || '';
          } catch (e) {}

          const newContentBase64 = Buffer.from(JSON.stringify(postsData, null, 2)).toString('base64');
          const putData = JSON.stringify({
            message: commitMessage,
            content: newContentBase64,
            sha: sha || undefined,
            branch: GITHUB_BRANCH
          });

          const putOptions = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/contents/posts.json`,
            method: 'PUT',
            headers: {
              'User-Agent': 'LinkedIn-AutoPoster',
              'Authorization': `Bearer ${GITHUB_TOKEN}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(putData)
            }
          };

          const putReq = https.request(putOptions, (putRes) => {
            if (putRes.statusCode >= 200 && putRes.statusCode < 300) {
              console.log('✅ [GitHub Auto-Sync] Sincronización exitosa con el repositorio remoto.');
              resolve(true);
            } else {
              resolve(false);
            }
          });

          putReq.on('error', () => resolve(false));
          putReq.write(putData);
          putReq.end();
        });
      });

      getReq.on('error', () => resolve(false));
      getReq.end();
    } catch (e) {
      resolve(false);
    }
  });
}

// Helper to read database
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify([]));
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database:', error);
    return [];
  }
}

// Helper to write database with automatic GitHub cloud persistence
function writeDB(data, commitMsg) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    syncToGitHub(data, commitMsg).catch(() => {});
    return true;
  } catch (error) {
    console.error('Error writing database:', error);
    return false;
  }
}

// Helper to read config
function readConfig() {
  let fileConfig = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      fileConfig = JSON.parse(data);
    }
  } catch (error) {
    console.error('Error reading config file:', error);
  }

  return {
    provider: 'Composio (LinkedIn API Directo)',
    personUrn: LINKEDIN_PERSON_URN,
    autoPublishEnabled: fileConfig.autoPublishEnabled !== undefined ? fileConfig.autoPublishEnabled : true,
    blockedDates: Array.isArray(fileConfig.blockedDates) ? fileConfig.blockedDates : [],
    githubConnected: !!GITHUB_TOKEN
  };
}

// Helper to write config
function writeConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing config:', error);
    return false;
  }
}

// Algorithm to calculate the next available scheduling slot (Mon-Fri at 9:00 AM Chile / 13:00 UTC)
async function getNextAvailableSlot(existingPosts) {
  const config = readConfig();
  const allowedDays = [1, 2, 3, 4, 5]; // Mon, Tue, Wed, Thu, Fri
  const targetHourUTC = 13; // 9:00 AM Chile Time (CLT / UTC-4) corresponds to 13:00 UTC
  const targetMinuteUTC = 0;

  const scheduledDates = new Set(
    existingPosts
      .filter(p => (p.status === 'scheduled' || p.status === 'published') && p.scheduledDate)
      .map(p => {
        const dateObj = new Date(p.scheduledDate);
        return dateObj.toLocaleDateString('sv-SE');
      })
  );

  if (config.blockedDates && Array.isArray(config.blockedDates)) {
    config.blockedDates.forEach(d => scheduledDates.add(d.trim()));
  }

  let current = new Date();
  
  for (let i = 0; i < 100; i++) {
    const dayOfWeek = current.getUTCDay();
    
    if (allowedDays.includes(dayOfWeek)) {
      const isToday = i === 0;
      const hours = current.getUTCHours();
      const candidateDateStr = current.toLocaleDateString('sv-SE');

      // If today is past the target hour, skip today
      if (isToday && hours >= targetHourUTC) {
        current.setUTCDate(current.getUTCDate() + 1);
        continue;
      }

      if (!scheduledDates.has(candidateDateStr)) {
        const slot = new Date(current);
        slot.setUTCHours(targetHourUTC, targetMinuteUTC, 0, 0);
        return slot.toISOString();
      }
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  
  const fallback = new Date();
  fallback.setUTCDate(fallback.getUTCDate() + 1);
  fallback.setUTCHours(targetHourUTC, targetMinuteUTC, 0, 0);
  return fallback.toISOString();
}

// Helper to parse SSE streaming response from Composio MCP
function parseSSEResponse(body) {
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const jsonStr = line.slice(6).trim();
      try {
        return JSON.parse(jsonStr);
      } catch (e) {}
    }
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    return null;
  }
}

// Helper to upload an image asset to Composio S3 storage
function uploadImageToComposio(imageUrl) {
  return new Promise((resolve) => {
    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) {
      return resolve(null);
    }

    const pythonScript = `
import requests, tempfile, json
try:
    res = requests.get("${imageUrl}", timeout=30)
    if res.status_code == 200:
        ext = ".jpg"
        ctype = res.headers.get("content-type", "").lower()
        if "png" in ctype: ext = ".png"
        elif "webp" in ctype: ext = ".webp"
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
            f.write(res.content)
            tmp = f.name
        upload_res, err = upload_local_file(tmp)
        s3k = upload_res.get("s3key") if upload_res else None
        print("JSON_START" + json.dumps({"s3key": s3k, "error": err, "ext": ext, "mimetype": ctype or "image/jpeg"}) + "JSON_END")
    else:
        print("JSON_START" + json.dumps({"error": f"HTTP {res.status_code}"}) + "JSON_END")
except Exception as e:
    print("JSON_START" + json.dumps({"error": str(e)}) + "JSON_END")
`;

    const rpcData = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'COMPOSIO_REMOTE_WORKBENCH',
        arguments: {
          code_to_execute: pythonScript
        }
      }
    });

    const options = {
      hostname: 'connect.composio.dev',
      port: 443,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COMPOSIO_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(rpcData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = parseSSEResponse(body);
          const contentText = parsed?.result?.content?.[0]?.text || body;
          const match = contentText.match(/JSON_START(.*?)JSON_END/);
          if (match) {
            let jsonStr = match[1];
            if (jsonStr.startsWith('\\"')) {
              jsonStr = JSON.parse('"' + jsonStr + '"');
            }
            let info;
            try {
              info = JSON.parse(jsonStr);
            } catch (e) {
              info = JSON.parse(match[1].replace(/\\"/g, '"'));
            }
            if (info && info.s3key) {
              return resolve(info);
            }
          }
          resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(35000, () => {
      req.destroy();
      resolve(null);
    });
    req.write(rpcData);
    req.end();
  });
}

// Native Composio MCP Publisher (Publishes directly to LinkedIn API via Composio with image asset)
async function publishToLinkedInViaComposio(postText, imageUrl) {
  // Strictly sanitize author URN to match the connected Composio account
  const authorUrn = (LINKEDIN_PERSON_URN && !LINKEDIN_PERSON_URN.includes('800423380'))
    ? LINKEDIN_PERSON_URN
    : 'urn:li:person:-4DFGTk-xF';

  const toolArgs = {
    author: authorUrn,
    commentary: postText,
    visibility: 'PUBLIC'
  };

  // Upload and attach image asset if available
  if (imageUrl) {
    try {
      console.log(`🖼️ [Composio Engine] Subiendo asset de imagen a Composio S3 (${imageUrl.substring(0, 60)}...)...`);
      const uploadInfo = await uploadImageToComposio(imageUrl);
      if (uploadInfo && uploadInfo.s3key) {
        toolArgs.images = [
          {
            name: 'post_visual_asset' + (uploadInfo.ext || '.jpg'),
            mimetype: uploadInfo.mimetype || 'image/jpeg',
            s3key: uploadInfo.s3key
          }
        ];
        console.log(`   -> ✅ Asset visual adjuntado exitosamente (s3key: ${uploadInfo.s3key})`);
      } else {
        console.warn(`   -> ⚠️ No se pudo obtener s3key del asset. Se continuará con publicación estándar.`);
      }
    } catch (err) {
      console.warn(`   -> ⚠️ Error subiendo asset: ${err.message}. Se continuará con publicación estándar.`);
    }
  }

  return new Promise((resolve, reject) => {
    const rpcData = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'COMPOSIO_MULTI_EXECUTE_TOOL',
        arguments: {
          thought: 'Publish post directly to LinkedIn with attached media asset',
          tools: [
            {
              tool_slug: 'LINKEDIN_CREATE_LINKED_IN_POST',
              arguments: toolArgs
            }
          ],
          sync_response_to_workbench: false
        }
      }
    });

    const options = {
      hostname: 'connect.composio.dev',
      port: 443,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COMPOSIO_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(rpcData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = parseSSEResponse(body);
          const contentText = parsed?.result?.content?.[0]?.text;
          if (contentText) {
            const inner = JSON.parse(contentText);
            const toolResult = inner?.data?.results?.[0];
            if (toolResult?.response?.successful) {
              const postData = toolResult.response.data || {};
              resolve({
                success: true,
                id: postData.id || postData.x_restli_id || Date.now().toString(),
                data: postData
              });
            } else {
              reject(new Error(toolResult?.response?.error || 'Error al publicar en LinkedIn vía Composio'));
            }
            return;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, data: { raw: body } });
          } else {
            reject(new Error(`Composio API Error (${res.statusCode}): ${body.substring(0, 200)}`));
          }
        } catch (e) {
          reject(new Error(`Error parseando respuesta de Composio: ${e.message}`));
        }
      });
    });

    req.on('error', err => reject(new Error(`Error de red con Composio: ${err.message}`)));
    req.write(rpcData);
    req.end();
  });
}

// Deduplication and In-Flight Locks (Strict zero-duplicate publishing guarantee)
const inFlightPublishing = new Set();
const publishedCache = new Set();

// Preload publishedCache on boot
try {
  const initialPosts = readDB();
  initialPosts.forEach(p => {
    if (p.status === 'published') publishedCache.add(p.id);
  });
  console.log(`🔒 [Safety Guard] Inicializados ${publishedCache.size} posts en el registro de publicados.`);
} catch (e) {}

let isAutoPublishRunning = false;

// Periodic In-Server Auto-Publish Engine (runs every 60s 24/7 on Render)
setInterval(async () => {
  if (isAutoPublishRunning) return; // Prevent overlapping ticks
  isAutoPublishRunning = true;

  try {
    const config = readConfig();
    if (!config.autoPublishEnabled) return;

    const posts = readDB();
    const now = new Date();
    let updated = false;

    for (const post of posts) {
      if (
        post.status === 'scheduled' &&
        post.scheduledDate &&
        new Date(post.scheduledDate).getTime() <= now.getTime()
      ) {
        // Strict guard: Skip if already published or currently publishing
        if (inFlightPublishing.has(post.id) || publishedCache.has(post.id)) {
          continue;
        }

        inFlightPublishing.add(post.id);
        console.log(`📡 [Composio Engine] Publicando Post ID ${post.id} ("${post.title.substring(0, 30)}...") vía Composio...`);

        try {
          const res = await publishToLinkedInViaComposio(post.text, post.image);
          post.status = 'published';
          post.publishedAt = new Date().toISOString();
          post.composioPostId = res.id;
          publishedCache.add(post.id);
          updated = true;
          console.log(`   -> ✅ Publicado exitosamente en LinkedIn vía Composio! ID: ${post.composioPostId}`);
        } catch (err) {
          console.error(`   -> ❌ Error al publicar vía Composio: ${err.message}`);
        } finally {
          inFlightPublishing.delete(post.id);
        }
      }
    }

    if (updated) {
      writeDB(posts, 'Composio Engine: Publicación automática de posts programados');
    }
  } catch (err) {
    console.error('Error en loop de auto-publicación:', err);
  } finally {
    isAutoPublishRunning = false;
  }
}, 60000);

// API Routes

// 1. Get all posts
app.get('/api/posts', (req, res) => {
  const posts = readDB();
  res.json(posts);
});

// 1.1 Sync client cache with server (Restores client approvals across server restarts)
app.post('/api/posts/sync-client', (req, res) => {
  const { scheduledMap = {}, publishedIds = [] } = req.body;
  const posts = readDB();
  let updated = false;

  posts.forEach(p => {
    if (p.status === 'draft' && scheduledMap[p.id]) {
      p.status = 'scheduled';
      p.scheduledDate = scheduledMap[p.id];
      updated = true;
    }
    if (p.status !== 'published' && publishedIds.includes(p.id)) {
      p.status = 'published';
      p.publishedAt = p.publishedAt || p.scheduledDate || new Date().toISOString();
      updated = true;
    }
  });

  if (updated) {
    writeDB(posts, 'Sync client approved and published posts');
  }

  res.json({ success: true, posts });
});

// 2. Get Configuration
app.get('/api/config', (req, res) => {
  const config = readConfig();
  res.json({
    isConnected: true,
    provider: 'Composio (LinkedIn API Directo)',
    personUrn: config.personUrn || 'urn:li:person:-4DFGTk-xF',
    autoPublishEnabled: config.autoPublishEnabled,
    blockedDates: config.blockedDates || [],
    githubConnected: config.githubConnected
  });
});

// 3. Save Configuration
app.post('/api/config', (req, res) => {
  const currentConfig = readConfig();
  const newConfig = {
    autoPublishEnabled: req.body.autoPublishEnabled !== undefined ? req.body.autoPublishEnabled : currentConfig.autoPublishEnabled,
    blockedDates: req.body.blockedDates !== undefined ? req.body.blockedDates : currentConfig.blockedDates
  };

  if (writeConfig(newConfig)) {
    res.json({ success: true, message: 'Configuración guardada' });
  } else {
    res.status(500).json({ error: 'No se pudo guardar la configuración' });
  }
});

// 4. Publish Post directly via Composio API to LinkedIn
app.post('/api/posts/:id/publish-api', async (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  const post = posts[index];

  if (post.status === 'published' || publishedCache.has(post.id)) {
    return res.status(400).json({ error: 'Esta publicación ya figura como publicada en LinkedIn. No se enviará de nuevo.' });
  }

  if (inFlightPublishing.has(post.id)) {
    return res.status(409).json({ error: 'Esta publicación se está enviando a LinkedIn en este momento. Por favor espera.' });
  }

  inFlightPublishing.add(post.id);

  try {
    const result = await publishToLinkedInViaComposio(post.text, post.image);
    
    posts[index].status = 'published';
    posts[index].publishedAt = new Date().toISOString();
    posts[index].composioPostId = result.id;
    publishedCache.add(post.id);
    writeDB(posts, `Published post ${post.id} to LinkedIn via Composio`);

    res.json({ success: true, message: 'Publicado exitosamente en tu perfil de LinkedIn vía Composio!', result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    inFlightPublishing.delete(post.id);
  }
});

// 5. Add a new post manually
app.post('/api/posts', (req, res) => {
  const posts = readDB();
  const newPost = {
    id: Date.now().toString(),
    status: req.body.status || 'draft',
    title: req.body.title || 'Nueva Publicación',
    text: req.body.text || '',
    image: req.body.image || '',
    scheduledDate: req.body.scheduledDate || null,
    author: req.body.author || 'Manual',
    originalUrl: req.body.originalUrl || '',
    category: req.body.category || 'General'
  };

  posts.push(newPost);
  if (writeDB(posts, `Add new post "${newPost.title}"`)) {
    res.status(201).json(newPost);
  } else {
    res.status(500).json({ error: 'No se pudo guardar la publicación' });
  }
});

// 6. Update an existing post
app.put('/api/posts/:id', async (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  const oldDate = posts[index].scheduledDate;
  const newDate = req.body.scheduledDate !== undefined ? req.body.scheduledDate : posts[index].scheduledDate;

  const updatedPost = {
    ...posts[index],
    title: req.body.title !== undefined ? req.body.title : posts[index].title,
    text: req.body.text !== undefined ? req.body.text : posts[index].text,
    image: req.body.image !== undefined ? req.body.image : posts[index].image,
    scheduledDate: newDate,
    status: req.body.status !== undefined ? req.body.status : posts[index].status,
    category: req.body.category !== undefined ? req.body.category : posts[index].category
  };

  // If date changed, reset any scheduled tracking
  if (newDate && newDate !== oldDate && updatedPost.status === 'scheduled') {
    updatedPost.scheduledDate = newDate;
  }

  posts[index] = updatedPost;
  if (writeDB(posts, `Update post ${req.params.id} "${updatedPost.title}"`)) {
    res.json(updatedPost);
  } else {
    res.status(500).json({ error: 'No se pudo actualizar la publicación' });
  }
});

// 7. Delete a post
app.delete('/api/posts/:id', (req, res) => {
  const posts = readDB();
  const filteredPosts = posts.filter(p => p.id !== req.params.id);

  if (posts.length === filteredPosts.length) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  if (writeDB(filteredPosts, `Delete post ${req.params.id}`)) {
    res.json({ success: true, message: 'Publicación eliminada' });
  } else {
    res.status(500).json({ error: 'No se pudo eliminar la publicación' });
  }
});

// 8. Approve a draft (Schedules for auto-publishing via Composio at 9:00 AM Chile)
app.post('/api/posts/:id/approve', async (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  if (posts[index].status === 'published') {
    return res.json({ 
      ...posts[index],
      message: 'Esta publicación ya fue publicada anteriormente. Se mantiene su estado.' 
    });
  }

  const slot = await getNextAvailableSlot(posts);

  posts[index].status = 'scheduled';
  posts[index].scheduledDate = slot;

  if (writeDB(posts, `Approve & schedule post ${req.params.id} for ${slot}`)) {
    res.json(posts[index]);
  } else {
    res.status(500).json({ error: 'No se pudo aprobar la publicación' });
  }
});

// 9. Mark a post as published manually
app.post('/api/posts/:id/publish', (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  posts[index].status = 'published';
  posts[index].publishedAt = posts[index].publishedAt || new Date().toISOString();

  if (writeDB(posts, `Mark post ${req.params.id} as published manually`)) {
    res.json(posts[index]);
  } else {
    res.status(500).json({ error: 'No se pudo marcar como publicada' });
  }
});

// 10. System Status & Health Check
app.get('/api/health', (req, res) => {
  const posts = readDB();
  const scheduledCount = posts.filter(p => p.status === 'scheduled').length;
  const publishedCount = posts.filter(p => p.status === 'published').length;
  const draftsCount = posts.filter(p => p.status === 'draft').length;

  res.json({
    status: 'ok',
    provider: 'Composio Direct LinkedIn API',
    author: LINKEDIN_PERSON_URN,
    posts: {
      total: posts.length,
      scheduled: scheduledCount,
      published: publishedCount,
      drafts: draftsCount
    },
    inFlightCount: inFlightPublishing.size,
    timestamp: new Date().toISOString()
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 Servidor de LinkedIn (vía Composio Direct Engine) en: http://localhost:${PORT}`);
  console.log(`🔑 Composio Conectado: ${LINKEDIN_PERSON_URN} (nicolaspeñadiaz)`);
  console.log(`📁 Zona Horaria: 9:00 AM Chile (13:00 UTC)`);
  console.log(`📅 Días de Publicación: Lunes a Viernes (1, 2, 3, 4, 5)`);
  console.log(`🛡️ Composio Direct LinkedIn API Scheduling Activado`);
  console.log(`📁 Base de datos local: ${DB_FILE}`);
  console.log(`==================================================`);
});
