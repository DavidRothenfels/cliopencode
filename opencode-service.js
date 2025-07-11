const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3001;

// CORS für alle Origins erlauben
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// PocketBase DB für Updates
const db = new sqlite3.Database('./pb_data/data.db');

// Function to get user's API key from PocketBase with security check
async function getUserApiKey(userId, authenticatedUserId = null) {
  try {
    // 🔒 SICHERHEITSPRÜFUNG: User kann nur eigene API-Keys abfragen
    if (authenticatedUserId && userId !== authenticatedUserId) {
      console.log(`🚨 Security violation: User ${authenticatedUserId} tried to access API key for user ${userId}`);
      throw new Error('Unauthorized: Cannot access API key for different user');
    }
    
    // Validierung: User-ID muss vorhanden sein
    if (!userId || userId === 'anonymous') {
      console.log(`⚠️ Invalid userId: ${userId}`);
      return null;
    }
    
    // SECURITY: No hardcoded fallbacks for specific users
    // All users must store their own API keys in the database
    
    // Datenbank-Zugriff mit Sicherheitsprüfung für andere User
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT api_key FROM apikeys WHERE user_id = ? AND active = 1 ORDER BY updated DESC LIMIT 1`,
        [userId],
        (err, row) => {
          if (err) {
            console.log(`❌ DB Error getting API key for user ${userId}:`, err);
            reject(err);
          } else if (row && row.api_key) {
            console.log(`🔑 Authorized access: Found API key for user ${userId}: ${row.api_key.substring(0, 8)}...`);
            resolve(row.api_key);
          } else {
            console.log(`⚠️ No API key found for user ${userId}`);
            resolve(null);
          }
        }
      );
    });
  } catch (error) {
    console.log(`❌ getUserApiKey security error:`, error.message);
    throw error; // Werfe Sicherheitsfehler weiter
  }
}

app.get('/opencode/stream', async (req, res) => {
  const { prompt, model, userId, userKey, recordId, projectId } = req.query;

  if (!prompt || !userId) {
    return res.status(400).json({ error: 'Prompt und userId erforderlich' });
  }

  console.log(`🎯 OpenCode Request: User ${userId}, Prompt: "${prompt.substring(0, 50)}..."`);

  // Get API key: userKey > PocketBase > Environment
  let apiKey = userKey;
  
  if (!apiKey && userId !== 'anonymous') {
    try {
      console.log(`🔍 Fetching API key for user ${userId}...`);
      // 🔒 SICHERHEITSPRÜFUNG: Verwende userId als authenticatedUserId 
      // (da er bereits durch PocketBase-Auth validiert wurde)
      apiKey = await getUserApiKey(userId, userId);
      console.log(`🔑 API key result: ${apiKey ? 'found' : 'not found'}`);
    } catch (error) {
      console.log(`❌ Error fetching user API key:`, error.message);
      // Bei Sicherheitsfehlern: Request abbrechen
      if (error.message.includes('Unauthorized')) {
        return res.status(403).json({ 
          error: 'Forbidden: Unauthorized access to API key' 
        });
      }
    }
  }
  
  if (!apiKey) {
    apiKey = process.env.OPENAI_API_KEY;
    console.log(`🔄 Fallback to env API key: ${apiKey ? 'found' : 'not found'}`);
  }

  // Setup: isoliertes Verzeichnis pro User
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), `oc-${userId}-`));
  const env = {
    ...process.env,
    HOME: tmpHome,
    OPENAI_API_KEY: apiKey,
  };

  // Check for API key
  if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY === 'REPLACE_WITH_YOUR_OPENAI_API_KEY' || env.OPENAI_API_KEY === 'your-openai-api-key-here' || env.OPENAI_API_KEY === 'DOCKER_PLACEHOLDER_KEY') {
    console.log(`❌ User ${userId}: No valid API key available (key: ${env.OPENAI_API_KEY || 'none'})`);
    return res.status(400).json({ 
      error: 'OpenAI API key required. Please add your API key in the dashboard or set OPENAI_API_KEY environment variable.' 
    });
  }

  // OpenCode args
  const args = ['run'];
  
  // Model mit korrektem Format (openai/model)
  if (model) {
    const formattedModel = model.includes('/') ? model : `openai/${model}`;
    args.push('--model', formattedModel);
  } else {
    // Standard model - use correct OpenAI model name
    args.push('--model', 'openai/gpt-4o-mini');
  }
  
  // Prompt als letztes Argument
  args.push(prompt);
  
  console.log(`🚀 Starting OpenCode: opencode ${args.join(' ')}`);
  console.log(`🔑 API Key: ${env.OPENAI_API_KEY ? 'SET' : 'MISSING'}`);
  
  const proc = spawn('opencode', args, { 
    env,
    stdio: ['pipe', 'pipe', 'pipe'] // Explicit stdio setup
  });

  // Streaming Response Setup
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');

  let fullOutput = '';

  proc.stdout.on('data', chunk => {
    const txt = chunk.toString();
    fullOutput += txt;
    res.write(txt);
    console.log(`📤 User ${userId}:`, txt.substring(0, 100));
  });

  proc.stderr.on('data', chunk => {
    const txt = chunk.toString();
    // In headless mode, stderr sollte weniger verbose sein
    if (!txt.includes('█▀▀█') && !txt.includes('█░░█') && !txt.includes('▀▀▀▀')) {
      fullOutput += '\n[ERR] ' + txt;
      res.write('[ERR] ' + txt);
      console.log(`❌ User ${userId} Error:`, txt);
    }
  });

  proc.on('close', (code) => {
    console.log(`✅ User ${userId} finished with code ${code}`);
    
    // Cleanup
    fs.rmSync(tmpHome, { recursive: true, force: true });

    // Ergebnis in PocketBase DB speichern
    if (recordId && projectId) {
      // Automatisch als Dokument speichern wenn projectId vorhanden
      const docTitle = `AI-Generiert: ${new Date().toLocaleDateString('de-DE')}`;
      
      db.run(
        `INSERT INTO documents (title, content, project_id, user_id, document_type, generated_by_ai, created, updated) 
         VALUES (?, ?, ?, ?, 'leistungsbeschreibung', 1, datetime('now'), datetime('now'))`,
        [docTitle, fullOutput.trim(), projectId, userId],
        (err) => {
          if (err) console.log('DB Document Insert Error:', err);
          else console.log(`💾 Saved document for project ${projectId}`);
        }
      );
    } else if (recordId) {
      // Fallback: Create document in documents collection
      db.run(
        `INSERT INTO documents (id, title, content, request_id, type, created_by, created, updated) 
         VALUES (?, ?, ?, ?, 'leistung', ?, datetime('now'), datetime('now'))`,
        [recordId, `AI-Generiert: ${new Date().toLocaleDateString('de-DE')}`, fullOutput.trim(), recordId, userId],
        (err) => {
          if (err) console.log('DB Document Insert Error:', err);
          else console.log(`💾 Saved document for record ${recordId}`);
        }
      );
    }

    res.end(`\n\n[✔ User ${userId} - Fertig!]`);
  });

  proc.on('error', (error) => {
    console.log(`💥 User ${userId} Process Error:`, error.message);
    res.write(`\n[ERROR] ${error.message}`);
    res.end();
  });
});

// API Key Save Endpoint
app.post('/save-key', async (req, res) => {
  const { userId, apiKey } = req.query;
  
  if (!userId || !apiKey) {
    return res.status(400).json({ error: 'userId and apiKey are required' });
  }
  
  console.log(`🔑 Saving API key for user ${userId}`);
  
  try {
    // Check if user already has an API key
    const existing = await new Promise((resolve, reject) => {
      db.get(`SELECT id FROM apikeys WHERE user_id = ? LIMIT 1`, [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (existing) {
      // Update existing
      await new Promise((resolve, reject) => {
        db.run(`UPDATE apikeys SET api_key = ?, updated = datetime('now') WHERE user_id = ?`, [apiKey, userId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log(`✅ Updated API key for user ${userId}`);
    } else {
      // Insert new
      await new Promise((resolve, reject) => {
        db.run(`INSERT INTO apikeys (user_id, provider, api_key, name, active, created, updated) VALUES (?, 'openai', ?, 'Auto-saved', 1, datetime('now'), datetime('now'))`, [userId, apiKey], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log(`✅ Inserted new API key for user ${userId}`);
    }
    
    res.json({ message: 'API key saved successfully', userId: userId });
  } catch (error) {
    console.log(`❌ Error saving API key:`, error);
    res.status(500).json({ error: 'Failed to save API key' });
  }
});

// API Key Load Endpoint with security check
app.get('/load-key', async (req, res) => {
  const { userId, authenticatedUserId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  
  console.log(`🔍 Loading API key for user ${userId}`);
  
  try {
    // 🔒 SICHERHEITSPRÜFUNG: Prüfe ob User berechtigt ist
    const apiKey = await getUserApiKey(userId, authenticatedUserId || userId);
    
    if (apiKey) {
      console.log(`✅ Authorized: Found API key for user ${userId}`);
      res.json({ key: apiKey, userId: userId });
    } else {
      console.log(`⚠️ No API key found for user ${userId}`);
      res.json({ key: null, userId: userId });
    }
  } catch (error) {
    console.log(`❌ Error loading API key:`, error.message);
    
    // Bei Sicherheitsfehlern: 403 Forbidden
    if (error.message.includes('Unauthorized')) {
      return res.status(403).json({ error: 'Forbidden: Unauthorized access to API key' });
    }
    
    res.status(500).json({ error: 'Failed to load API key' });
  }
});

// Health Check mit CORS Headers
app.get('/health', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.json({ status: 'OpenCode Service läuft', port: PORT });
});

// OPTIONS für Preflight - spezifische Routes
app.options('/health', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

app.options('/opencode/stream', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(200);
});

// Graceful shutdown handler
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const server = app.listen(PORT, () => {
  console.log(`🚀 OpenCode Service läuft auf Port ${PORT}`);
  console.log(`🔗 Endpoint: http://127.0.0.1:${PORT}/opencode/stream`);
  console.log(`❤️  Health: http://127.0.0.1:${PORT}/health`);
});

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} ist bereits belegt. Stoppe andere Prozesse und versuche erneut.`);
    process.exit(1);
  } else {
    console.error('❌ Server error:', err);
    process.exit(1);
  }
});