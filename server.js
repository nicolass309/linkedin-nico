const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'posts.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper to determine active Redirect URI dynamically (Local vs Cloud)
function getRedirectURI(req) {
  if (process.env.REDIRECT_URI) return process.env.REDIRECT_URI;
  if (req) {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers.host;
    return `${protocol}://${host}/auth/linkedin/callback`;
  }
  return `http://localhost:${PORT}/auth/linkedin/callback`;
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

// Helper to read config (Merges environment variables with config.json)
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
    linkedinClientId: process.env.LINKEDIN_CLIENT_ID || fileConfig.linkedinClientId || '',
    linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET || fileConfig.linkedinClientSecret || '',
    linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN || fileConfig.linkedinAccessToken || '',
    linkedinPersonUrn: process.env.LINKEDIN_PERSON_URN || fileConfig.linkedinPersonUrn || '',
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

// Fetch remote posts directly from LinkedIn API to detect occupied dates
function fetchLinkedInRemotePosts(authorUrn, accessToken) {
  return new Promise((resolve) => {
    if (!accessToken || !authorUrn) return resolve([]);

    let formattedAuthor = authorUrn.trim();
    if (!formattedAuthor.startsWith('urn:li:')) {
      formattedAuthor = `urn:li:person:${formattedAuthor}`;
    }

    const encodedAuthor = encodeURIComponent(formattedAuthor);
    const options = {
      hostname: 'api.linkedin.com',
      port: 443,
      path: `/rest/posts?q=author&author=${encodedAuthor}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'LinkedIn-Version': '202401',
        'X-Restli-Protocol-Version': '2.0.0'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const parsed = JSON.parse(body);
            const elements = parsed.elements || [];
            const dates = elements.map(el => {
              const ts = el.createdAt || el.publishedAt;
              return ts ? new Date(ts).toLocaleDateString('sv-SE') : null;
            }).filter(Boolean);
            resolve(dates);
          } else {
            resolve([]);
          }
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.end();
  });
}

// Algorithm to calculate the next available scheduling slot (Mon, Wed, Thu, Fri at 9:00 AM)
// Blocks local posts, remote API posts, AND native LinkedIn web UI scheduled dates!
async function getNextAvailableSlot(existingPosts, extraRemoteDates = []) {
  const config = readConfig();
  const allowedDays = [1, 3, 4, 5]; // 1 = Mon, 3 = Wed, 4 = Thu, 5 = Fri
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

  // Block dates from remote LinkedIn API
  extraRemoteDates.forEach(d => scheduledDates.add(d));

  // Block native LinkedIn UI scheduled dates configured in config.json
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

// LinkedIn API Post Publisher Function
function publishToLinkedInAPI(postText, authorUrn, accessToken) {
  return new Promise((resolve, reject) => {
    if (!accessToken || !authorUrn) {
      return reject(new Error('Faltan credenciales de LinkedIn (Access Token o Person URN)'));
    }

    let formattedAuthor = authorUrn.trim();
    if (!formattedAuthor.startsWith('urn:li:')) {
      formattedAuthor = `urn:li:person:${formattedAuthor}`;
    }

    const postData = JSON.stringify({
      author: formattedAuthor,
      commentary: postText,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED'
      }
    });

    const options = {
      hostname: 'api.linkedin.com',
      port: 443,
      path: '/rest/posts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': '202401',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, statusCode: res.statusCode, data: responseBody });
        } else {
          console.error('LinkedIn API Error Response:', responseBody);
          reject(new Error(`Error de API de LinkedIn (Código ${res.statusCode}): ${responseBody}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

// Helper: HTTP POST Request for OAuth Token Exchange
function exchangeOAuthCode(clientId, clientSecret, code, redirectUri) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      grant_type: 'authorization_code',
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri
    });

    const options = {
      hostname: 'www.linkedin.com',
      port: 443,
      path: '/oauth/v2/accessToken',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error_description || `Error intercambiando código OAuth (Código ${res.statusCode})`));
          }
        } catch (e) {
          reject(new Error('Respuesta inválida del servidor de OAuth de LinkedIn'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Helper: Get LinkedIn User Profile via OpenID Connect (/v2/userinfo)
function fetchLinkedInUserInfo(accessToken) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.linkedin.com',
      port: 443,
      path: '/v2/userinfo',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(body));
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.end();
  });
}

// Background Automatic Scheduler Task (runs 24/7 every 60 seconds)
setInterval(async () => {
  const config = readConfig();
  if (!config.autoPublishEnabled || !config.linkedinAccessToken) return;

  const posts = readDB();
  const now = new Date();
  let updated = false;

  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    if (p.status === 'scheduled' && p.scheduledDate) {
      const scheduledTime = new Date(p.scheduledDate);
      
      if (now >= scheduledTime) {
        console.log(`⏰ [24/7 Cloud Engine] Publicando post ID: ${p.id} - "${p.title}"`);
        try {
          await publishToLinkedInAPI(p.text, config.linkedinPersonUrn, config.linkedinAccessToken);
          posts[i].status = 'published';
          posts[i].publishedAt = now.toISOString();
          updated = true;
          console.log(`✅ [24/7 Cloud Engine] Post ID ${p.id} publicado exitosamente en LinkedIn!`);
        } catch (err) {
          console.error(`❌ [24/7 Cloud Engine] Error al publicar post ID ${p.id}:`, err.message);
        }
      }
    }
  }

  if (updated) {
    writeDB(posts);
  }
}, 60000);

// API Routes

// OAuth 2.0 Redirect Initiator
app.get('/auth/linkedin', (req, res) => {
  const config = readConfig();
  const clientId = req.query.client_id || config.linkedinClientId;

  if (!clientId) {
    return res.status(400).send('Error: Debes ingresar tu Client ID de LinkedIn primero.');
  }

  if (req.query.client_id || req.query.client_secret) {
    if (req.query.client_id) config.linkedinClientId = req.query.client_id.trim();
    if (req.query.client_secret) config.linkedinClientSecret = req.query.client_secret.trim();
    writeConfig(config);
  }

  const redirectUri = getRedirectURI(req);
  const scope = encodeURIComponent('w_member_social openid profile email');
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}`;
  
  res.redirect(authUrl);
});

// OAuth 2.0 Callback Receiver
app.get('/auth/linkedin/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/?oauth_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect('/?oauth_error=No%20se%20recibio%20codigo%20de%20autorizacion');
  }

  const config = readConfig();
  const redirectUri = getRedirectURI(req);

  try {
    const tokenData = await exchangeOAuthCode(config.linkedinClientId, config.linkedinClientSecret, code, redirectUri);
    config.linkedinAccessToken = tokenData.access_token;

    const userInfo = await fetchLinkedInUserInfo(tokenData.access_token);
    if (userInfo && userInfo.sub) {
      config.linkedinPersonUrn = `urn:li:person:${userInfo.sub}`;
    }

    writeConfig(config);
    res.redirect('/?linkedin_connected=true');
  } catch (err) {
    res.redirect(`/?oauth_error=${encodeURIComponent(err.message)}`);
  }
});

// 1. Get all posts
app.get('/api/posts', (req, res) => {
  const posts = readDB();
  res.json(posts);
});

// 2. Get LinkedIn Configuration
app.get('/api/config', (req, res) => {
  const config = readConfig();
  const redirectUri = getRedirectURI(req);

  res.json({
    isConnected: !!config.linkedinAccessToken,
    clientId: config.linkedinClientId || '',
    clientSecret: config.linkedinClientSecret ? `••••••••${config.linkedinClientSecret.slice(-4)}` : '',
    personUrn: config.linkedinPersonUrn || '',
    autoPublishEnabled: config.autoPublishEnabled,
    blockedDates: config.blockedDates || [],
    maskedToken: config.linkedinAccessToken ? `••••••••${config.linkedinAccessToken.slice(-6)}` : '',
    redirectUri: redirectUri
  });
});

// 3. Save LinkedIn Configuration
app.post('/api/config', (req, res) => {
  const currentConfig = readConfig();
  const newConfig = {
    linkedinClientId: req.body.linkedinClientId !== undefined ? req.body.linkedinClientId.trim() : currentConfig.linkedinClientId,
    linkedinClientSecret: req.body.linkedinClientSecret !== undefined ? req.body.linkedinClientSecret.trim() : currentConfig.linkedinClientSecret,
    linkedinAccessToken: req.body.linkedinAccessToken !== undefined ? req.body.linkedinAccessToken.trim() : currentConfig.linkedinAccessToken,
    linkedinPersonUrn: req.body.linkedinPersonUrn !== undefined ? req.body.linkedinPersonUrn.trim() : currentConfig.linkedinPersonUrn,
    autoPublishEnabled: req.body.autoPublishEnabled !== undefined ? req.body.autoPublishEnabled : currentConfig.autoPublishEnabled,
    blockedDates: req.body.blockedDates !== undefined ? req.body.blockedDates : currentConfig.blockedDates
  };

  if (writeConfig(newConfig)) {
    res.json({ success: true, message: 'Configuración de LinkedIn guardada' });
  } else {
    res.status(500).json({ error: 'No se pudo guardar la configuración' });
  }
});

// 4. Sync occupied dates with LinkedIn API
app.get('/api/linkedin/sync', async (req, res) => {
  const config = readConfig();
  if (!config.linkedinAccessToken) {
    return res.json({ synced: false, message: 'LinkedIn no está conectado' });
  }

  const remoteDates = await fetchLinkedInRemotePosts(config.linkedinPersonUrn, config.linkedinAccessToken);
  res.json({ synced: true, blockedDatesCount: remoteDates.length, blockedDates: remoteDates });
});

// 5. Publish Post directly to LinkedIn API
app.post('/api/posts/:id/publish-api', async (req, res) => {
  const posts = readDB();
  const config = readConfig();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  if (!config.linkedinAccessToken) {
    return res.status(400).json({ error: 'Debes conectar tu cuenta de LinkedIn primero en la sección de Configuración.' });
  }

  const post = posts[index];

  try {
    const result = await publishToLinkedInAPI(post.text, config.linkedinPersonUrn, config.linkedinAccessToken);
    
    posts[index].status = 'published';
    posts[index].publishedAt = new Date().toISOString();
    writeDB(posts);

    res.json({ success: true, message: 'Publicado exitosamente en tu perfil de LinkedIn!', result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Add a new post manually
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

// 7. Update an existing post
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

// 8. Delete a post
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

// 9. Approve a draft
app.post('/api/posts/:id/approve', async (req, res) => {
  const posts = readDB();
  const config = readConfig();
  const index = posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Publicación no encontrada' });
  }

  const remoteDates = await fetchLinkedInRemotePosts(config.linkedinPersonUrn, config.linkedinAccessToken);
  const slot = await getNextAvailableSlot(posts, remoteDates);

  posts[index].status = 'scheduled';
  posts[index].scheduledDate = slot;

  if (writeDB(posts)) {
    res.json(posts[index]);
  } else {
    res.status(500).json({ error: 'No se pudo aprobar la publicación' });
  }
});

// 10. Mark a post as published manually
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
  console.log(`🚀 Servidor de LinkedIn corriendo en: http://localhost:${PORT}`);
  console.log(`📁 Base de datos local: ${DB_FILE}`);
  console.log(`==================================================`);
});
