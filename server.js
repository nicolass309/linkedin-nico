const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'posts.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Buffer API Integration Secrets
const BUFFER_API_KEY = process.env.BUFFER_API_KEY || 'YmF96n9SMorADYaTUnwaknAJtbZ-6yTrQElNgLN1H3Z';
const BUFFER_CHANNEL_ID = process.env.BUFFER_CHANNEL_ID || '6a7749ba99afb4434926a809';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

// Helper to write database
function writeDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
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
    blockedDates: Array.isArray(fileConfig.blockedDates) ? fileConfig.blockedDates : []
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

// Algorithm to calculate the next available scheduling slot (Mon, Wed, Thu, Fri at 9:00 AM)
async function getNextAvailableSlot(existingPosts) {
  const config = readConfig();
  const allowedDays = [1, 3, 4, 5];
  const targetHour = 9;
  const targetMinute = 0;

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
    const dayOfWeek = current.getDay();
    
    if (allowedDays.includes(dayOfWeek)) {
      const isToday = i === 0;
      const hours = current.getHours();
      const candidateDateStr = current.toLocaleDateString('sv-SE');

      if (isToday && hours >= targetHour) {
        current.setDate(current.getDate() + 1);
        continue;
      }

      if (!scheduledDates.has(candidateDateStr)) {
        const slot = new Date(current);
        slot.setHours(targetHour, targetMinute, 0, 0);
        return slot.toISOString();
      }
    }
    current.setDate(current.getDate() + 1);
  }
  
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 1);
  fallback.setHours(targetHour, targetMinute, 0, 0);
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

// Background Automatic Scheduler Task (runs 24/7 every 60 seconds)
setInterval(async () => {
  const config = readConfig();
  if (!config.autoPublishEnabled) return;

  const posts = readDB();
  const now = new Date();
  let updated = false;

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    if (p.status === 'scheduled' && p.scheduledDate) {
      const scheduledTime = new Date(p.scheduledDate);
      
      if (now >= scheduledTime) {
        console.log(`⏰ [24/7 Buffer Engine] Publicando post ID: ${p.id} - "${p.title}"`);
        try {
          await publishToLinkedInAPI(p.text, p.image);
          posts[i].status = 'published';
          posts[i].publishedAt = now.toISOString();
          updated = true;
          console.log(`✅ [24/7 Buffer Engine] Post ID ${p.id} publicado exitosamente en LinkedIn vía Buffer!`);
        } catch (err) {
          console.error(`❌ [24/7 Buffer Engine] Error al publicar post ID ${p.id}:`, err.message);
        }
      }
    }
  }

  if (updated) {
    writeDB(posts);
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
    blockedDates: config.blockedDates || []
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

// 4. Publish Post directly via Buffer API to LinkedIn
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
    writeDB(posts);

    res.json({ success: true, message: 'Publicado exitosamente en tu perfil de LinkedIn vía Buffer con imagen!', result });
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
  if (writeDB(posts)) {
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
  if (writeDB(posts)) {
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

  if (writeDB(filteredPosts)) {
    res.json({ success: true, message: 'Publicación eliminada' });
  } else {
    res.status(500).json({ error: 'No se pudo eliminar la publicación' });
  }
});

// 8. Approve a draft
app.post('/api/posts/:id/approve', async (req, res) => {
  const posts = readDB();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  const slot = await getNextAvailableSlot(posts);

  posts[index].status = 'scheduled';
  posts[index].scheduledDate = slot;

  if (writeDB(posts)) {
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

  if (writeDB(posts)) {
    res.json(posts[index]);
  } else {
    res.status(500).json({ error: 'No se pudo marcar como publicada' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 Servidor de LinkedIn (vía Buffer Engine) en: http://localhost:${PORT}`);
  console.log(`🔑 Buffer Channel: ${BUFFER_CHANNEL_ID} (nicolaspeñadiaz)`);
  console.log(`📁 Base de datos local: ${DB_FILE}`);
  console.log(`==================================================`);
});
