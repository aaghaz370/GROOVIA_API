const express = require('express');
const cors = require('cors');
const { Innertube, UniversalCache, ClientType } = require('youtubei.js');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

let ytAuth = null;
let ytAndroid = null; // Android client — bypasses IP rate limiting like NewPipe does!

// Web client for metadata browsing
async function getYT() {
  if (!ytAuth) {
    ytAuth = await Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
    });
  }
  return ytAuth;
}

// Android client for stream extraction — YouTube allows full access from Android clients
async function getAndroidYT() {
  if (!ytAndroid) {
    ytAndroid = await Innertube.create({
      client_type: ClientType.ANDROID,
      cache: new UniversalCache(false),
      generate_session_locally: true,
    });
  }
  return ytAndroid;
}

// Convert thumbnail URLs to beautiful High Resolution (max quality, no compression)
function getHDThumbnail(thumbnails) {
  if (!thumbnails) return '';
  let url = '';
  
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    url = thumbnails[thumbnails.length - 1]?.url || '';
  } else if (thumbnails && thumbnails.url) {
    url = thumbnails.url;
  }
  
  if (!url || typeof url !== 'string') return '';
  
  // Force high-quality: remove size restrictions, compression markers
  // Pattern: =w60-h60-l90-rj → =w800-h800
  url = url.replace(/=w\d+-h\d+.*$/, '=w800-h800');
  // Pattern: wXXX-hXXX inside path → w800-h800
  url = url.replace(/w\d+-h\d+-[a-z0-9\-]+$/, 'w800-h800');
  
  return url;
}

// Known curated playlist IDs from YouTube Music for supplementary sections
const CURATED_PLAYLISTS = [
  { title: '🔥 Trending Right Now',  id: 'PLZoTAELtkkbgn7-under-the-radar' },
  { title: '🎵 Top 50 India',        id: 'PLg7s9T43OHxonWxz8EAnXXJDRMHR9N0Cv' },
  { title: '💔 Heartbreak Anthems',  id: 'RDAT9M7RurZN0KQ' },
  { title: '🌙 Late Night Vibes',    id: 'RDATLXSxncXp01o0A' },
  { title: '🎤 Arijit Singh Hits',   id: 'PLg7s9T43OHxpWS0GBo5OJ5E-DoDGaLlbr' },
];

// Safely extract title text from any YT Music structure
function parseTitle(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.text) return typeof obj.text === 'string' ? obj.text : '';
  if (obj.runs && Array.isArray(obj.runs)) return obj.runs.map(r => r.text || '').join('');
  return '';
}

// Find the best available HD thumbnail, skipping empty ones
function getHDThumbnail(thumbnails) {
  if (!thumbnails) return '';
  let candidates = [];
  
  if (Array.isArray(thumbnails)) {
    candidates = thumbnails;
  } else if (thumbnails.thumbnails && Array.isArray(thumbnails.thumbnails)) {
    candidates = thumbnails.thumbnails;
  }
  
  // Sort by size descending (largest first)
  const sorted = candidates.filter(t => t?.url && t.url.length > 0);
  if (!sorted.length) return '';
  
  // Pick the biggest thumbnail available
  const largest = sorted.sort((a,b) => (b.width || 0) - (a.width || 0))[0];
  let url = largest.url;
  
  // Upgrade resolution in URL
  url = url.replace(/=w\d+-h\d+.*$/, '=w800-h800');
  url = url.replace(/-w\d+-h\d+.*$/, '-w800-h800');
  return url;
}

// Extract text from youtubei.js Title/Text objects (class instances or plain strings)
function extractText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  // youtubei.js Text class has .text property
  if (typeof obj.text === 'string') return obj.text;
  // runs-style (array of text segments)
  if (Array.isArray(obj.runs)) return obj.runs.map(r => r?.text || '').join('');
  // fallback: toString sometimes works
  const str = String(obj);
  return (str === '[object Object]') ? '' : str;
}

// Extract best HD URL from youtubei.js thumbnail objects (class instances or plain arrays)
function extractThumb(thumbs) {
  if (!thumbs) return '';
  
  // Convert to array if possible
  let arr = null;
  if (Array.isArray(thumbs)) {
    arr = thumbs;
  } else if (thumbs && typeof thumbs[Symbol.iterator] === 'function') {
    arr = Array.from(thumbs);
  } else {
    return '';
  }
  
  // Filter valid http URLs
  const valid = arr.filter(t => t?.url && typeof t.url === 'string' && t.url.startsWith('http'));
  if (!valid.length) return '';
  
  // Sort by size (largest first)
  valid.sort((a, b) => (b.width || b.height || 0) - (a.width || a.height || 0));
  return upgradeURL(valid[0].url);
}

// Map raw youtubei item → clean object. Returns null if not useful.
function mapItem(item) {
  try {
    if (!item) return null;
    
    // Skip non-music content types
    const type = item.type || '';
    if (['MusicNavigationButton','MusicMultiRowListItem','MusicDescriptionShelf','Message'].includes(type)) return null;

    // Try various thumbnail locations (youtubei uses different props per item class)
    const imageUrl = extractThumb(item.thumbnails)
                  || extractThumb(item.thumbnail)
                  || extractThumb(item.thumbnails?.flat?.());
    if (!imageUrl) return null;

    const title = extractText(item.title || item.name);
    if (!title) return null;

    const id = item.id 
            || item.endpoint?.payload?.videoId 
            || item.endpoint?.payload?.browseId 
            || '';

    return {
      id,
      title,
      subtitle: extractText(item.subtitle || item.secondary_subtitle),
      type: type || 'Song',
      thumbnails: [{ url: imageUrl }],
      artists: item.artists ? extractText(item.artists) : null,
    };
  } catch {
    return null;
  }
}

function upgradeURL(url) {
  if (!url || typeof url !== 'string') return url || '';
  url = url.replace(/=w\d+-h\d+.*$/, '=w800-h800');
  url = url.replace(/-w\d+-h\d+.*$/, '-w800-h800');
  return url;
}

// 1. Get YouTube Music Homepage (10+ rich sections)
app.get('/api/home', async (req, res) => {
  try {
    const yt = await getYT();

    // Fire 5 parallel fetches: YT Music home + explore + 3 searches
    const [homeResult, exploreResult, searchResult1, searchResult2, searchResult3] = await Promise.allSettled([
      yt.music.getHomeFeed(),
      yt.music.getExplore(),
      yt.search('trending pop music 2024'),
      yt.search('top bollywood hits 2024'),
      yt.search('top english pop songs')
    ]);

    const sections = [];
    const seenTitles = new Set(); // prevent duplicate sections

    const pushSection = (title, rawItems) => {
      if (!rawItems || !Array.isArray(rawItems)) return;
      if (seenTitles.has(title)) return;
      const mapped = rawItems.map(mapItem).filter(Boolean);
      if (mapped.length >= 3) {
        sections.push({ title, contents: mapped });
        seenTitles.add(title);
      }
    };

    // 1. YT Music Home Feed (page 0 only for reliability - Quick picks, Nostalgic, etc.)
    if (homeResult.status === 'fulfilled') {
      let feed = homeResult.value;
      if (feed.sections) {
        feed.sections.forEach(section => {
          const rawTitle = section.header?.title;
          const title = extractText(rawTitle) || 'Recommended';
          pushSection(title, section.contents);
        });
      }
      // Try 1 continuation page (reliable on first attempt)
      if (feed.has_continuation) {
        try {
          const feed2 = await feed.getContinuation();
          if (feed2?.sections) {
            feed2.sections.forEach(section => {
              const rawTitle = section.header?.title;
              const title = extractText(rawTitle) || 'Trending Picks';
              pushSection(title, section.contents);
            });
            // Try 2nd continuation
            if (feed2.has_continuation) {
              const feed3 = await feed2.getContinuation();
              if (feed3?.sections) {
                feed3.sections.forEach(section => {
                  const rawTitle = section.header?.title;
                  const title = extractText(rawTitle) || 'More For You';
                  pushSection(title, section.contents);
                });
              }
            }
          }
        } catch { /* continuation not always available in guest mode */ }
      }
    }

    // 2. YT Music Explore Feed (New albums, Trending, Music videos)
    if (exploreResult.status === 'fulfilled' && exploreResult.value.sections) {
      exploreResult.value.sections.forEach(section => {
        const title = section.header?.title?.text || section.header?.title || 'Discover';
        if (['Moods & genres', 'Popular episodes'].includes(title)) return;
        pushSection(typeof title === 'string' ? title : extractText(title), section.contents);
      });
    }

    // 3. Trending Pop Music (via regular YT search)
    if (searchResult1.status === 'fulfilled') {
      const videos = searchResult1.value.results || searchResult1.value.videos || [];
      pushSection('🔥 Trending Pop Music', videos.slice(0, 20));
    }

    // 4. Bollywood Top Hits (via regular YT search)
    if (searchResult2.status === 'fulfilled') {
      const videos = searchResult2.value.results || searchResult2.value.videos || [];
      pushSection('🎵 Bollywood Top Hits', videos.slice(0, 20));
    }

    // 5. English Pop Hits (via regular YT search)
    if (searchResult3.status === 'fulfilled') {
      const videos = searchResult3.value.results || searchResult3.value.videos || [];
      pushSection('🌍 English Pop Hits', videos.slice(0, 20));
    }

    res.json({
      success: true,
      data: { sections, total: sections.length, title: 'Groovia Home Feed' }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Search YouTube Music
app.get('/api/search', async (req, res) => {
  try {
    const { q, filter } = req.query; // filter can be: 'songs', 'videos', 'albums', 'artists', 'playlists'
    if (!q) return res.status(400).json({ success: false, message: 'Query parameter q is required.' });

    const yt = await getYT();
    const searchResults = await yt.music.search(q, { type: filter || 'all' });
    
    // We parse all categories
    const formattedResults = searchResults.contents?.map(section => ({
      title: section.title,
      items: section.contents?.map(item => ({
        id: item.id,
        type: item.type,
        title: item.title,
        artists: item.artists,
        album: item.album,
        duration: item.duration?.text,
        thumbnails: item.thumbnails
      }))
    })) || searchResults.contents;

    res.json({ success: true, data: formattedResults });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Song / Video Complete Details + Direct Stream URLs (Audio & Video)
app.get('/api/song/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Use Android client for stream extraction (bypasses IP blocks like NewPipe)
    const ytA = await getAndroidYT();
    const info = await ytA.getInfo(id);
    
    const title = info.basic_info.title || '';
    const artist = info.basic_info.channel?.name || '';

    // Extract audio streams directly from Android client response
    let audioUrl = null;
    try {
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });
      audioUrl = format?.url || null;
      console.log(`[Song] Android client extracted audio URL: ${audioUrl ? 'SUCCESS' : 'null'}`);
    } catch (fmtErr) {
      console.log('[Song] Android format extraction failed:', fmtErr.message);
    }

    // If Android client URL fails, try streaming info differently
    if (!audioUrl) {
      try {
        const streamingData = info.streaming_data;
        if (streamingData?.adaptive_formats) {
          const audioFormats = streamingData.adaptive_formats
            .filter(f => f.mime_type?.includes('audio'))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (audioFormats.length > 0) {
            audioUrl = audioFormats[0].url;
            console.log('[Song] Got URL from streaming_data adaptive_formats');
          }
        }
      } catch (sdErr) {
        console.log('[Song] streaming_data extraction failed:', sdErr.message);
      }
    }

    // Last resort: JioSaavn title search
    if (!audioUrl) {
      try {
        const cleanTitle = title.replace(/\(.*?\)/g, '').split('|')[0].trim();
        const q = encodeURIComponent(`${cleanTitle} ${artist}`.trim());
        const saavnRes = await fetch(`https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${q}`);
        const saavnData = await saavnRes.json();
        const results = saavnData?.data?.results;
        if (results?.length > 0) {
          const links = results[0]?.downloadUrl || [];
          if (links.length > 0) audioUrl = links[links.length - 1]?.link;
          console.log('[Song] JioSaavn fallback:', audioUrl ? 'SUCCESS' : 'no URL');
        }
      } catch (saavnErr) {
        console.log('[Song] JioSaavn fallback failed:', saavnErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        id: info.basic_info.id,
        title,
        channel: artist,
        duration: info.basic_info.duration,
        thumbnails: info.basic_info.thumbnail,
        stream_urls: { audio: audioUrl, video: null },
      }
    });
  } catch (error) {
    console.log('[Song] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Lyrics
app.get('/api/lyrics/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const yt = await getYT();
    const lyrics = await yt.music.getLyrics(id);

    res.json({ success: true, data: lyrics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Radio (Up Next Queue Generation)
app.get('/api/radio/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const yt = await getYT();
    const upNext = await yt.music.getUpNext(id);
    res.json({ success: true, data: upNext });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Charts dynamically based on IP or Country
app.get('/api/charts', async (req, res) => {
  try {
    const country = req.query.country || 'IN'; // Defaults to India
    const yt = await getYT();
    
    // We can fetch from ytmusic.getExplore() or custom playlist mapping
    const explore = await yt.music.getExplore();
    
    res.json({ success: true, data: explore });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Album Details
app.get('/api/album/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const yt = await getYT();
    const album = await yt.music.getAlbum(id);
    res.json({ success: true, data: album });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Artist Details
app.get('/api/artist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const yt = await getYT();
    const artist = await yt.music.getArtist(id);
    res.json({ success: true, data: artist });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health Checker
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Welcome to Groovia API Engine (YouTube Music Unblocked)' });
});

// Start Server (Ignored by Vercel, used by Render/Local)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Groovia API] Running on http://0.0.0.0:${PORT} (Accessible on LAN)`);
  });
}

module.exports = app;
