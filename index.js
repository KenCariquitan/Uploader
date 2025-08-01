import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
dotenv.config({ path: './token.env' });

// Add these lines for ES module __dirname support
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/' }); // Store temp files here
// === CONFIG ===
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'https://inspection-uploader.onrender.com/oauth2callback';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID;  // This is your main Google Drive folder ID



// === GOOGLE AUTH ===
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// === SERVE THE UI ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

// === HELPER: Create or Get Folder ===
async function getOrCreateFolder(name, parentId) {
  const q = `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const result = await drive.files.list({ q, fields: 'files(id, name)' });

  if (result.data.files.length > 0) {
    return result.data.files[0].id;
  }

  const folder = await drive.files.create({
    resource: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  return folder.data.id;
}

// === API ROUTES ===
// Get existing districts
app.get('/api/districts', async (req, res) => {
  try {
    console.log('API: Fetching districts from ROOT_FOLDER_ID:', ROOT_FOLDER_ID);

    if (!ROOT_FOLDER_ID) {
      return res.status(500).json({ error: 'ROOT_FOLDER_ID not configured' });
    }

    const result = await drive.files.list({
      q: `'${ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(name)'
    });

    console.log('API: Districts result:', result.data.files);
    const districts = result.data.files.map(file => file.name);
    console.log('API: Sending districts:', districts);

    res.json(districts);
  } catch (error) {
    console.error('API: Error fetching districts:', error);
    res.status(500).json({ error: 'Failed to fetch districts', details: error.message });
  }
});

// Get schools for a specific district
app.get('/api/schools/:district', async (req, res) => {
  try {
    const districtName = decodeURIComponent(req.params.district);
    console.log('API: Fetching schools for district:', districtName);

    if (!ROOT_FOLDER_ID) {
      return res.status(500).json({ error: 'ROOT_FOLDER_ID not configured' });
    }

    // First, find the district folder
    const districtQuery = `'${ROOT_FOLDER_ID}' in parents and name='${districtName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    console.log('API: District query:', districtQuery);

    const districtResult = await drive.files.list({
      q: districtQuery,
      fields: 'files(id, name)'
    });

    console.log('API: District result:', districtResult.data.files);

    if (districtResult.data.files.length === 0) {
      console.log('API: District not found, returning empty array');
      return res.json([]); // District doesn't exist yet
    }

    const districtId = districtResult.data.files[0].id;
    console.log('API: District ID:', districtId);

    // Then get schools in that district
    const schoolsResult = await drive.files.list({
      q: `'${districtId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(name)'
    });

    console.log('API: Schools result:', schoolsResult.data.files);
    const schools = schoolsResult.data.files.map(file => file.name);
    console.log('API: Sending schools:', schools);

    res.json(schools);
  } catch (error) {
    console.error('API: Error fetching schools:', error);
    res.status(500).json({ error: 'Failed to fetch schools', details: error.message });
  }
});

// === MULTIPLE FILE UPLOAD ROUTE ===
app.post('/upload', upload.array('photos', 10), async (req, res) => {
  try {
    const { district, school } = req.body;
    const files = req.files;

    if (!district || !school || !files?.length) {
      return res.status(400).send('❌ Missing required fields or files');
    }

    const districtId = await getOrCreateFolder(district, ROOT_FOLDER_ID);
    const schoolId = await getOrCreateFolder(school, districtId);

    const results = [];

    for (const file of files) {
      const metadata = {
        name: file.originalname,
        parents: [schoolId],
      };

      const media = {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
      };

      const uploaded = await drive.files.create({
        resource: metadata,
        media,
        fields: 'id, name',
      });

      results.push(uploaded.data.name);
      fs.unlinkSync(file.path); // Clean up
    }

    res.send(`✅ Files uploaded: ${results.join(', ')}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('❌ Upload failed');
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});