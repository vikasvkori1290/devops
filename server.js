const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Serve static directory
app.use(express.static(__dirname));

let mongoClient = null;
let db = null;
let progressCollection = null;
let isConnected = false;
let connectionError = null;

async function connectToMongo(uri) {
  if (!uri || uri.includes('your_mongodb_connection_string_here') || uri.trim() === '') {
    isConnected = false;
    connectionError = 'No MongoDB URI configured. Please configure MONGODB_URI.';
    return false;
  }

  try {
    if (mongoClient) {
      try { await mongoClient.close(); } catch (e) {}
    }
    console.log('Connecting to MongoDB...');
    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
    
    // Use 'devops_roadmap' database or database from URI
    db = mongoClient.db('devops_roadmap');
    progressCollection = db.collection('progress');
    isConnected = true;
    connectionError = null;
    console.log('Successfully connected to MongoDB!');
    return true;
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    isConnected = false;
    if (err.message.includes('alert number 80') || err.message.includes('tlsv1 alert internal error')) {
      connectionError = 'Atlas IP Firewall: Your current IP is blocked by MongoDB Atlas. Please add 0.0.0.0/0 in your MongoDB Atlas dashboard under Security > Network Access.';
    } else {
      connectionError = err.message;
    }
    return false;
  }
}

let connectingPromise = null;

async function ensureConnected() {
  if (isConnected && progressCollection) return true;
  if (!process.env.MONGODB_URI) return false;
  if (!connectingPromise) {
    connectingPromise = connectToMongo(process.env.MONGODB_URI).finally(() => {
      connectingPromise = null;
    });
  }
  return await connectingPromise;
}

// Initial connection attempt with environment variable
if (process.env.MONGODB_URI) {
  ensureConnected();
} else {
  connectionError = 'MONGODB_URI not defined in environment or .env';
}

// Middleware to guarantee MongoDB connection on serverless cold starts
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api') && req.path !== '/api/config-uri') {
    if (!isConnected && process.env.MONGODB_URI) {
      await ensureConnected();
    }
  }
  next();
});

// Route to get MongoDB status
app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    error: connectionError,
    uriConfigured: Boolean(process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('your_mongodb_connection_string_here')),
    currentUri: process.env.MONGODB_URI || ''
  });
});

// Route to update MongoDB URI dynamically
app.post('/api/config-uri', async (req, res) => {
  const { uri } = req.body;
  if (!uri || typeof uri !== 'string') {
    return res.status(400).json({ success: false, error: 'URI is required' });
  }

  const trimmedUri = uri.trim();
  const ok = await connectToMongo(trimmedUri);
  
  if (ok) {
    // Save to .env file
    try {
      const envPath = path.join(__dirname, '.env');
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
        if (envContent.includes('MONGODB_URI=')) {
          envContent = envContent.replace(/MONGODB_URI=.*/g, `MONGODB_URI="${trimmedUri}"`);
        } else {
          envContent += `\nMONGODB_URI="${trimmedUri}"\n`;
        }
      } else {
        envContent = `PORT=${PORT}\nMONGODB_URI="${trimmedUri}"\n`;
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
      process.env.MONGODB_URI = trimmedUri;
    } catch (e) {
      console.warn('Could not persist to .env file:', e.message);
    }

    return res.json({ success: true, message: 'Connected to MongoDB successfully!' });
  } else {
    return res.status(400).json({ success: false, error: connectionError });
  }
});

// GET progress
app.get('/api/progress', async (req, res) => {
  if (!isConnected || !progressCollection) {
    return res.json({
      connected: false,
      error: connectionError || 'Not connected to MongoDB',
      checkboxes: {},
      startDate: null
    });
  }

  try {
    const doc = await progressCollection.findOne({ _id: 'roadmap_progress' });
    if (!doc) {
      return res.json({
        connected: true,
        checkboxes: {},
        startDate: null
      });
    }

    return res.json({
      connected: true,
      checkboxes: doc.checkboxes || {},
      startDate: doc.startDate || null,
      updatedAt: doc.updatedAt || null
    });
  } catch (err) {
    console.error('Error fetching progress:', err);
    res.status(500).json({ connected: false, error: err.message });
  }
});

// POST single checkbox toggle (saves as id: true / false)
app.post('/api/checkbox', async (req, res) => {
  const { id, checked } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Checkbox ID is required' });
  }

  if (!isConnected || !progressCollection) {
    return res.status(503).json({ error: 'MongoDB not connected', isConnected: false });
  }

  try {
    const isTrue = Boolean(checked);
    await progressCollection.updateOne(
      { _id: 'roadmap_progress' },
      {
        $set: {
          [`checkboxes.${id}`]: isTrue,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    return res.json({ success: true, id, checked: isTrue });
  } catch (err) {
    console.error('Error updating checkbox:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST full update / start date
app.post('/api/progress', async (req, res) => {
  const { startDate, checkboxes } = req.body;

  if (!isConnected || !progressCollection) {
    return res.status(503).json({ error: 'MongoDB not connected', isConnected: false });
  }

  try {
    const updateObj = { updatedAt: new Date() };
    if (startDate !== undefined) updateObj.startDate = startDate;
    if (checkboxes !== undefined) updateObj.checkboxes = checkboxes;

    await progressCollection.updateOne(
      { _id: 'roadmap_progress' },
      { $set: updateObj },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('Error updating progress document:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fallback to HTML
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'DevOps Roadmap Tracker.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
