const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'posts.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Buffer API Integration Secrets
const BUFFER_API_KEY = process.env.BUFFER_API_KEY || 'YmF96n9SMorADYaTUnwaknAJtbZ-6yTrQElNgLN1H3Z';
const BUFFER_CHANNEL_ID = process.env.BUFFER_CHANNEL_ID || '6a7749ba99afb4434926a809';

// GitHub Sync Secrets (Optional for persistent automatic commits on Render)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'nicolass309/linkedin-nico';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper to compute unique content signature for deduplication
function getPostSignature(title, text) {
  const clean = (String(title || '') + '|' + String(text || ''))
    .toLowerCase()
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(clean).digest('hex');
}

// Helper to push updates to GitHub repo automatically
function syncToGitHub(postsData, commitMsg = 'Auto-sync posts database from dashboard') {
  if (!GITHUB_TOKEN) return Promise.resolve(false);

  return new Promise((resolve) => {
    try {
      const getOptions = {
        hostname: 'api.github.com',
        port: 443,
        path: `/repos/${GITHUB_REPO}/contents/posts.json?ref=${GITHUB_BRANCH}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'LinkedIn-Automation-Dashboard',
          'Accept': 'application/vnd.github.v3+json'
        }
      };

      const getReq = https.request(getOptions, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          let sha = null;
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(body);
              sha = parsed.sha;
            } catch (e) {}
          }

          const putData = JSON.stringify({
            message: commitMsg,
            content: Buffer.from(JSON.stringify(postsData, null, 2)).toString('base64'),
            branch: GITHUB_BRANCH,
            ...(sha ? { sha } : {})
          });

          const putOptions = {
            hostname: 'api.github.com',
            port: 443,
            path: `/repos/${GITHUB_REPO}/contents/posts.json`,
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${GITHUB_TOKEN}`,
              'User-Agent': 'LinkedIn-Automation-Dashboard',
              'Accept': 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(putData)
            }
          };

          const putReq = https.request(putOptions, (putRes) => {
            if (putRes.statusCode >= 200 && putRes.statusCode < 300) {
              console.log('☁️ [GitHub Cloud Sync] posts.json sincronizado y commiteado exitosamente a GitHub');
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
    // Asynchronously sync to GitHub if token available
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
    bufferApiKey: BUFFER_API_KEY,
    bufferChannelId: BUFFER_CHANNEL_ID,
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

// Seamless Buffer GraphQL API Publisher with Image Support for LinkedIn
function publishToLinkedInAPI(postText, imageUrl) {
  return new Promise((resolve, reject) => {
    const query = `
      mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          __typename
          ... on PostActionSuccess {
            post {
              id
              status
            }
          }
        }
      }
    `;

    const variables = {
      input: {
        channelId: BUFFER_CHANNEL_ID,
        text: postText,
        mode: "shareNow",
        schedulingType: "automatic"
      }
    };

    if (imageUrl && imageUrl.trim()) {
      variables.input.assets = [
        {
          image: {
            url: imageUrl.trim()
          }
        }
      ];
    }

    const postData = JSON.stringify({ query, variables });

    const options = {
      hostname: 'api.buffer.com',
      port: 443,
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BUFFER_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.data && parsed.data.createPost && parsed.data.createPost.post) {
            resolve({ success: true, statusCode: res.statusCode, data: parsed.data.createPost.post });
          } else {
            reject(new Error(`Buffer API Error (${res.statusCode}): ${JSON.stringify(parsed.errors || body)}`));
          }
        } catch (e) {
          reject(new Error(`Error de comunicación con Buffer API (${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// State tracking for Anti-Spam & Auto-Publish Firewall
let isPublishingBusy = false;
let lastPublishTimestamp = 0;
const MIN_INTERVAL_BETWEEN_AUTO_POSTS_MS = 30 * 60 * 1000; // Minimum 30 min cooldown between auto posts

// Background Automatic Scheduler Task (runs 24/7 every 60 seconds with strict safety guards)
setInterval(async () => {
  const config = readConfig();
  if (!config.autoPublishEnabled) return;
  if (isPublishingBusy) return;

  const now = new Date();
  
  // Guard 1: Enforce minimum interval between any auto publications
  if (now.getTime() - lastPublishTimestamp < MIN_INTERVAL_BETWEEN_AUTO_POSTS_MS) {
    return;
  }

  const posts = readDB();
  let updated = false;

  // Build signatures of all previously published posts to prevent any duplicate
  const publishedSignatures = new Set(
    posts
      .filter(p => p.status === 'published')
      .map(p => getPostSignature(p.title, p.text))
  );

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    if (p.status === 'scheduled' && p.scheduledDate) {
      const scheduledTime = new Date(p.scheduledDate);
      const diffMs = now.getTime() - scheduledTime.getTime();

      // Guard 2: OVERDUE SAFETY SHIELD
      // If a post's scheduled date is more than 20 minutes in the past, DO NOT AUTO-PUBLISH!
      // This prevents the disaster of batch-publishing past posts when a server wakes up.
      if (diffMs > 20 * 60 * 1000) {
        console.warn(`🛡️ [Safety Shield] Post ID ${p.id} ("${p.title}") venció hace ${Math.round(diffMs / 60000)} minutos. Se desactiva la autopublicación en lote por seguridad.`);
        posts[i].status = 'draft';
        posts[i].scheduledDate = null;
        updated = true;
        continue;
      }

      // Guard 3: Active publication window (between 0 and 20 minutes from scheduled time)
      if (diffMs >= 0 && diffMs <= 20 * 60 * 1000) {
        const sig = getPostSignature(p.title, p.text);

        // Guard 4: Deduplication check
        if (publishedSignatures.has(sig)) {
          console.warn(`🛡️ [Deduplication Guard] Post ID ${p.id} ya fue publicado previamente con idéntico texto. Marcando como publicado sin duplicar en LinkedIn.`);
          posts[i].status = 'published';
          posts[i].publishedAt = now.toISOString();
          updated = true;
          continue;
        }

        console.log(`⏰ [24/7 Buffer Engine] Publicando post ID: ${p.id} - "${p.title}"`);
        isPublishingBusy = true;

        try {
          await publishToLinkedInAPI(p.text, p.image);
          posts[i].status = 'published';
          posts[i].publishedAt = now.toISOString();
          lastPublishTimestamp = now.getTime();
          publishedSignatures.add(sig);
          updated = true;
          console.log(`✅ [24/7 Buffer Engine] Post ID ${p.id} publicado exitosamente en LinkedIn vía Buffer!`);
        } catch (err) {
          console.error(`❌ [24/7 Buffer Engine] Error al publicar post ID ${p.id}:`, err.message);
        } finally {
          isPublishingBusy = false;
        }

        // Guard 5: Publish MAXIMUM 1 post per scheduler cycle to make spam impossible
        break;
      }
    }
  }

  if (updated) {
    writeDB(posts, 'Auto-update published statuses');
  }
}, 60000);

// API Routes

// 1. Get all posts
app.get('/api/posts', (req, res) => {
  const posts = readDB();
  res.json(posts);
});

// 2. Get Configuration
app.get('/api/config', (req, res) => {
  const config = readConfig();
  res.json({
    isConnected: true,
    provider: 'Buffer (LinkedIn)',
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

// 4. Publish Post directly via Buffer API to LinkedIn (with Deduplication Guard)
app.post('/api/posts/:id/publish-api', async (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  const post = posts[index];

  // Check if already published
  if (post.status === 'published') {
    return res.json({ 
      success: true, 
      alreadyPublished: true, 
      message: 'Esta publicación ya figura como publicada en LinkedIn. Se evitó duplicarla.', 
      post 
    });
  }

  // Deduplication check across all published posts
  const sig = getPostSignature(post.title, post.text);
  const alreadyPublished = posts.some(p => p.status === 'published' && getPostSignature(p.title, p.text) === sig);

  if (alreadyPublished) {
    posts[index].status = 'published';
    posts[index].publishedAt = posts[index].publishedAt || new Date().toISOString();
    writeDB(posts, `Mark post ${post.id} as published (duplicate prevented)`);
    return res.json({
      success: true,
      alreadyPublished: true,
      message: 'Un post con el mismo contenido ya fue publicado en LinkedIn anteriormente. Se marcó como Publicado para evitar duplicados.',
      post: posts[index]
    });
  }

  try {
    const result = await publishToLinkedInAPI(post.text, post.image);
    
    posts[index].status = 'published';
    posts[index].publishedAt = new Date().toISOString();
    lastPublishTimestamp = Date.now();
    writeDB(posts, `Published post ${post.id} to LinkedIn via Buffer`);

    res.json({ success: true, message: 'Publicado exitosamente en tu perfil de LinkedIn vía Buffer!', result });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
app.put('/api/posts/:id', (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  const updatedPost = {
    ...posts[index],
    title: req.body.title !== undefined ? req.body.title : posts[index].title,
    text: req.body.text !== undefined ? req.body.text : posts[index].text,
    image: req.body.image !== undefined ? req.body.image : posts[index].image,
    scheduledDate: req.body.scheduledDate !== undefined ? req.body.scheduledDate : posts[index].scheduledDate,
    status: req.body.status !== undefined ? req.body.status : posts[index].status,
    category: req.body.category !== undefined ? req.body.category : posts[index].category
  };

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

// 8. Approve a draft (with Future Slot and Deduplication Safety)
app.post('/api/posts/:id/approve', async (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  // Safety check: if already published, don't schedule again!
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

// 10. Client LocalStorage Sync Endpoint (Restores client approvals if server ever restarted)
app.post('/api/posts/sync-client', (req, res) => {
  const clientApproved = req.body.scheduledMap || {}; // Map of { [id]: { status, scheduledDate } }
  const clientPublished = req.body.publishedIds || []; // List of IDs published on client

  const posts = readDB();
  let updated = false;

  for (let i = 0; i < posts.length; i++) {
    const id = posts[i].id;
    
    // If client marked it published, keep it published
    if (clientPublished.includes(id) && posts[i].status !== 'published') {
      posts[i].status = 'published';
      posts[i].publishedAt = posts[i].publishedAt || new Date().toISOString();
      updated = true;
    }
    // If client approved it and backend still has it as draft, restore scheduled slot
    else if (clientApproved[id] && posts[i].status === 'draft') {
      posts[i].status = 'scheduled';
      posts[i].scheduledDate = clientApproved[id].scheduledDate;
      updated = true;
    }
  }

  if (updated) {
    writeDB(posts, 'Sync client-side local cache to server');
  }

  res.json({ success: true, posts });
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 Servidor de LinkedIn (vía Buffer Engine) en: http://localhost:${PORT}`);
  console.log(`🔑 Buffer Channel: ${BUFFER_CHANNEL_ID} (nicolaspeñadiaz)`);
  console.log(`📁 Zona Horaria: 9:00 AM Chile (13:00 UTC)`);
  console.log(`📅 Días de Publicación: Lunes a Viernes (1, 2, 3, 4, 5)`);
  console.log(`🛡️ Escudo Anti-Spam y Deduplicación Activado`);
  console.log(`📁 Base de datos local: ${DB_FILE}`);
  console.log(`==================================================`);
});
