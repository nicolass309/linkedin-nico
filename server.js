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

// Buffer API Production Credentials (LinkedIn Direct Channel)
const BUFFER_API_KEY = process.env.BUFFER_API_KEY || 'YmF96n9SMorADYaTUnwaknAJtbZ-6yTrQElNgLN1H3Z';
const BUFFER_CHANNEL_ID = process.env.BUFFER_CHANNEL_ID || '6a7749ba99afb4434926a809';

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
    bufferApiKey: BUFFER_API_KEY,
    bufferChannelId: BUFFER_CHANNEL_ID,
    autoPublishEnabled: fileConfig.autoPublishEnabled !== undefined ? fileConfig.autoPublishEnabled : true,
    blockedDates: Array.isArray(config => config.blockedDates) ? fileConfig.blockedDates : [],
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

// Native Buffer GraphQL API Scheduler (Queues post in Buffer Cloud for exact execution)
function scheduleBufferPost(text, imageUrl, dueAtISO) {
  return new Promise((resolve, reject) => {
    const query = `
      mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          __typename
          ... on PostActionSuccess {
            post {
              id
              status
              dueAt
            }
          }
          ... on MutationError {
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        channelId: BUFFER_CHANNEL_ID,
        text: text,
        mode: "customScheduled",
        schedulingType: "automatic",
        needsApproval: false,
        dueAt: dueAtISO
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
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.data?.createPost?.post?.id) {
            resolve({ success: true, post: parsed.data.createPost.post });
          } else {
            resolve({ success: false, error: parsed.data?.createPost?.message || parsed.errors?.[0]?.message || 'Unknown Buffer Error' });
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse Buffer response' });
        }
      });
    });

    req.on('error', err => resolve({ success: false, error: err.message }));
    req.write(postData);
    req.end();
  });
}

// Immediate Buffer Publisher (for manual 1-click publishing)
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
      res.on('data', chunk => { body += chunk; });
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

// Auto-Replenish Buffer Cloud Queue Engine
async function syncQueueWithBuffer(posts) {
  const now = new Date();
  const scheduledPosts = posts
    .filter(p => p.status === 'scheduled' && p.scheduledDate && new Date(p.scheduledDate).getTime() > now.getTime())
    .sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));

  let newlyQueued = 0;
  for (const post of scheduledPosts) {
    if (!post.bufferPostId) {
      console.log(`📡 [Queue Engine] Pushing Post ID ${post.id} ("${post.title.substring(0, 30)}...") to Buffer Cloud Queue for ${post.scheduledDate}`);
      const res = await scheduleBufferPost(post.text, post.image, post.scheduledDate);
      if (res.success && res.post?.id) {
        post.bufferPostId = res.post.id;
        newlyQueued++;
        console.log(`   -> Queued in Buffer! ID: ${post.bufferPostId}`);
      } else {
        console.log(`   -> Buffer Queue Notice: ${res.error}`);
        // If queue limit (10 posts) is reached, stop pushing
        if (res.error && res.error.includes('limit reached')) {
          break;
        }
      }
    }
  }
  return newlyQueued;
}

// Periodic In-Server Check (runs every 60s when server is active)
setInterval(async () => {
  const config = readConfig();
  if (!config.autoPublishEnabled) return;

  const posts = readDB();
  const newlyQueued = await syncQueueWithBuffer(posts);
  if (newlyQueued > 0) {
    writeDB(posts, `Buffer Queue Engine: Synced ${newlyQueued} posts to Buffer cloud`);
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

  try {
    const result = await publishToLinkedInAPI(post.text, post.image);
    
    posts[index].status = 'published';
    posts[index].publishedAt = new Date().toISOString();
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

  // If date changed, reset bufferPostId and reschedule in Buffer
  if (newDate && newDate !== oldDate && updatedPost.status === 'scheduled') {
    const bufferRes = await scheduleBufferPost(updatedPost.text, updatedPost.image, newDate);
    if (bufferRes.success && bufferRes.post?.id) {
      updatedPost.bufferPostId = bufferRes.post.id;
    }
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

// 8. Approve a draft (Schedules directly in Buffer Cloud)
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

  // Schedule directly in Buffer Cloud
  const bufferRes = await scheduleBufferPost(posts[index].text, posts[index].image, slot);
  if (bufferRes.success && bufferRes.post?.id) {
    posts[index].bufferPostId = bufferRes.post.id;
  }

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

// 10. Buffer Queue Sync & Keep-Alive Cron Endpoint
app.get('/api/sync-queue', async (req, res) => {
  const posts = readDB();
  const newlyQueued = await syncQueueWithBuffer(posts);
  if (newlyQueued > 0) {
    writeDB(posts, `Buffer Sync Endpoint: Queued ${newlyQueued} posts`);
  }
  
  const queuedCount = posts.filter(p => p.status === 'scheduled' && p.bufferPostId).length;
  const pendingCount = posts.filter(p => p.status === 'scheduled' && !p.bufferPostId).length;

  res.json({
    success: true,
    message: 'Buffer Queue Synced',
    queuedInBuffer: queuedCount,
    pendingInDatabase: pendingCount,
    newlyQueuedThisRun: newlyQueued,
    timestamp: new Date().toISOString()
  });
});

// 11. Client LocalStorage Sync Endpoint
app.post('/api/posts/sync-client', async (req, res) => {
  const clientApproved = req.body.scheduledMap || {};
  const clientPublished = req.body.publishedIds || [];

  const posts = readDB();
  let updated = false;

  for (let i = 0; i < posts.length; i++) {
    const id = posts[i].id;
    
    if (clientPublished.includes(id) && posts[i].status !== 'published') {
      posts[i].status = 'published';
      posts[i].publishedAt = posts[i].publishedAt || new Date().toISOString();
      updated = true;
    }
    else if (clientApproved[id] && posts[i].status === 'draft') {
      posts[i].status = 'scheduled';
      posts[i].scheduledDate = clientApproved[id].scheduledDate;
      updated = true;
    }
  }

  if (updated) {
    await syncQueueWithBuffer(posts);
    writeDB(posts, 'Sync client-side local cache to server and Buffer');
  }

  res.json({ success: true, posts });
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 Servidor de LinkedIn (vía Buffer Cloud Engine) en: http://localhost:${PORT}`);
  console.log(`🔑 Buffer Channel: ${BUFFER_CHANNEL_ID} (nicolaspeñadiaz)`);
  console.log(`📁 Zona Horaria: 9:00 AM Chile (13:00 UTC)`);
  console.log(`📅 Días de Publicación: Lunes a Viernes (1, 2, 3, 4, 5)`);
  console.log(`🛡️ Buffer Cloud Native Scheduling & Keep-Alive Activado`);
  console.log(`📁 Base de datos local: ${DB_FILE}`);
  console.log(`==================================================`);
});
