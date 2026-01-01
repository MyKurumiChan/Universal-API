// Cloudflare Worker for Twitter/X Media Downloader API - Get All Video Resolutions
export default {
  async fetch(request, env, ctx) {
    // Handle CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // PROXY Endpoint - Serve media files through proxy
    if (path.startsWith('/proxy/') && request.method === 'GET') {
      const mediaUrl = decodeURIComponent(path.replace('/proxy/', ''));
      return await proxyMediaRequest(mediaUrl);
    }

    // Support GET with URL parameter
    if (path.startsWith('/a/') && request.method === 'GET') {
      const tweetUrl = decodeURIComponent(path.replace('/a/', ''));
      return await handleScrapeRequestDirect(tweetUrl);
    }

    // API Routes
    if (path === '/a' && request.method === 'POST') {
      return await handleScrapeRequest(request);
    }

    // Health check
    if (path === '/health') {
      return jsonResponse({ status: 'ok', version: '2025.12.29' });
    }

    // Show only minimal info
    return new Response('API Service', { 
      status: 200,
      headers: corsHeaders('text/plain')
    });
  },
};

// =========================
//   PROXY MEDIA REQUEST
// =========================
async function proxyMediaRequest(mediaUrl) {
  try {
    // Validate URL
    if (!mediaUrl || !mediaUrl.startsWith('http')) {
      return new Response('Invalid URL', { status: 400 });
    }
    
    const response = await fetch(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://twitter.com/',
        'Origin': 'https://twitter.com',
        'Accept-Encoding': 'identity'
      },
      cf: {
        cacheTtl: 86400, // Cache for 24 hours
        cacheEverything: true,
      }
    });
    
    if (!response.ok) {
      return new Response(`Failed to fetch media: ${response.status}`, { 
        status: response.status 
      });
    }
    
    // Create new headers
    const headers = new Headers(response.headers);
    
    // Set CORS headers
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', '*');
    headers.set('Access-Control-Expose-Headers', '*');
    
    // Set content disposition for download
    if (mediaUrl.includes('.mp4') || mediaUrl.includes('.jpg') || mediaUrl.includes('.png')) {
      const filename = getFilenameFromUrl(mediaUrl);
      headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    }
    
    // Ensure correct content type
    if (mediaUrl.includes('.mp4')) {
      headers.set('Content-Type', 'video/mp4');
    } else if (mediaUrl.includes('.jpg') || mediaUrl.includes('.jpeg')) {
      headers.set('Content-Type', 'image/jpeg');
    } else if (mediaUrl.includes('.png')) {
      headers.set('Content-Type', 'image/png');
    }
    
    return new Response(response.body, {
      status: response.status,
      headers: headers
    });
    
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response('Proxy error: ' + error.message, { status: 500 });
  }
}

function getFilenameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const parts = pathname.split('/');
    return parts[parts.length - 1] || 'download';
  } catch {
    return 'download';
  }
}

// =========================
//   MAIN SCRAPING LOGIC
// =========================
async function handleScrapeRequestDirect(tweetUrl) {
  try {
    const statusId = extractStatusIdFromUrl(tweetUrl);
    
    if (!statusId) {
      return jsonResponse({ 
        success: false,
        error: 'Invalid URL' 
      }, 400);
    }

    console.log(`Processing: ${statusId}`);
    
    // Try BOTH APIs to get all data
    const [syndicationResult, fxtwitterResult] = await Promise.all([
      fetchViaSyndicationAPI(statusId),
      fetchViaFxtwitterAPI(statusId)
    ]);
    
    let result = syndicationResult || fxtwitterResult;
    
    if (!result || !result.media || result.media.length === 0) {
      // Try HTML scraping as last resort
      result = await fetchViaHTMLScraping(statusId);
    }
    
    if (!result || !result.media || result.media.length === 0) {
      return jsonResponse({ 
        success: false,
        error: 'Content not available',
        id: statusId
      }, 404);
    }
    
    // Enhance video data with all resolutions
    if (syndicationResult && syndicationResult.media && syndicationResult.media.length > 0) {
      result.media = await enhanceMediaWithResolutions(syndicationResult.media, statusId);
      result.method = 'api_a';
    } else {
      result.media = await enhanceMediaWithResolutions(result.media, statusId);
    }
    
    // Fix timestamp
    if (typeof result.created_at === 'number') {
      result.created_at = new Date(result.created_at * 1000).toISOString();
    }
    
    return jsonResponse({
      success: true,
      url: tweetUrl,
      id: statusId,
      method: result.method || 'standard',
      user: result.user,
      text: result.text,
      created_at: result.created_at,
      media: result.media,
      media_count: result.media.length,
      download_info: generateDownloadInfo(result, statusId),
    });
    
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({ 
      success: false, 
      error: 'Service error'
    }, 500);
  }
}

// =========================
//   SCRAPING METHODS
// =========================
async function fetchViaSyndicationAPI(tweetId) {
  try {
    const endpoints = [
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}`,
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=abc123`,
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`,
    ];
    
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        cf: {
          cacheTtl: 300,
          cacheEverything: true,
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        
        if (data.photos || data.video || data.animated_gif) {
          const result = {
            method: 'api_a',
            user: {
              name: data.user?.name || 'Unknown',
              screen_name: data.user?.screen_name || 'unknown',
              profile_image_url: data.user?.profile_image_url_https || '',
            },
            text: data.text || '',
            created_at: data.created_at || new Date().toISOString(),
            media: [],
          };
          
          // Extract photos
          if (data.photos && Array.isArray(data.photos)) {
            data.photos.forEach(photo => {
              result.media.push({
                type: 'photo',
                url: photo.url,
                download_url: photo.url + '?format=jpg&name=orig',
                width: photo.width,
                height: photo.height,
                size: `${photo.width}x${photo.height}`,
                variants: [{
                  url: photo.url + '?format=jpg&name=orig',
                  quality: 'original',
                  resolution: `${photo.width}x${photo.height}`
                }]
              });
            });
          }
          
          // Extract video with ALL variants
          if (data.video) {
            const videoItem = {
              type: 'video',
              thumbnail_url: data.video.thumbnail_url,
              duration: data.video.duration,
              width: data.video.width,
              height: data.video.height,
              size: `${data.video.width}x${data.video.height}`,
              variants: [],
            };
            
            if (data.video.variants && Array.isArray(data.video.variants)) {
              const mp4Variants = data.video.variants
                .filter(v => v.type === 'video/mp4' && v.src)
                .map(variant => ({
                  url: variant.src,
                  quality: getQualityFromResolution(getResolutionFromUrl(variant.src) || `${data.video.width}x${data.video.height}`),
                  bitrate: variant.bitrate,
                  content_type: variant.content_type || 'video/mp4',
                  resolution: getResolutionFromUrl(variant.src) || `${data.video.width}x${data.video.height}`,
                }));
              
              mp4Variants.sort((a, b) => {
                const resA = parseResolution(a.resolution);
                const resB = parseResolution(b.resolution);
                return (resB.width * resB.height) - (resA.width * resA.height);
              });
              
              videoItem.variants = mp4Variants;
              
              if (mp4Variants.length > 0) {
                videoItem.url = mp4Variants[0].url;
                videoItem.download_url = mp4Variants[0].url;
                videoItem.best_quality = mp4Variants[0].quality;
              }
            }
            
            result.media.push(videoItem);
          }
          
          // Extract GIF
          if (data.animated_gif) {
            const gifItem = {
              type: 'gif',
              thumbnail_url: data.animated_gif.thumbnail_url,
              width: data.animated_gif.width,
              height: data.animated_gif.height,
              size: `${data.animated_gif.width}x${data.animated_gif.height}`,
              variants: [],
            };
            
            if (data.animated_gif.variants && Array.isArray(data.animated_gif.variants)) {
              const gifVariants = data.animated_gif.variants
                .filter(v => v.type === 'video/mp4')
                .map(variant => ({
                  url: variant.src,
                  quality: getQualityFromResolution(getResolutionFromUrl(variant.src) || `${data.animated_gif.width}x${data.animated_gif.height}`),
                  bitrate: variant.bitrate,
                  content_type: variant.content_type || 'video/mp4',
                  resolution: getResolutionFromUrl(variant.src) || `${data.animated_gif.width}x${data.animated_gif.height}`,
                }));
                
              gifVariants.sort((a, b) => {
                const resA = parseResolution(a.resolution);
                const resB = parseResolution(b.resolution);
                return (resB.width * resB.height) - (resA.width * resA.height);
              });
              
              gifItem.variants = gifVariants;
              
              if (gifVariants.length > 0) {
                gifItem.url = gifVariants[0].url;
                gifItem.download_url = gifVariants[0].url;
              }
            }
            
            result.media.push(gifItem);
          }
          
          return result;
        }
      }
    }
  } catch (error) {
    // Silent error
  }
  return null;
}

async function fetchViaFxtwitterAPI(tweetId) {
  try {
    const response = await fetch(`https://api.fxtwitter.com/twitter/status/${tweetId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      cf: {
        cacheTtl: 300,
        cacheEverything: true,
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data.tweet && data.tweet.media) {
        const result = {
          method: 'api_b',
          user: {
            name: data.tweet.author?.name || 'Unknown',
            screen_name: data.tweet.author?.screen_name || 'unknown',
            profile_image_url: data.tweet.author?.avatar_url || '',
          },
          text: data.tweet.text || '',
          created_at: data.tweet.created_timestamp || new Date().toISOString(),
          media: [],
        };
        
        data.tweet.media.all.forEach(media => {
          if (media.type === 'photo' && media.url) {
            result.media.push({
              type: 'photo',
              url: media.url,
              download_url: media.url,
              width: media.width,
              height: media.height,
              size: `${media.width}x${media.height}`,
              variants: [{
                url: media.url,
                quality: 'original',
                resolution: `${media.width}x${media.height}`
              }]
            });
          } else if ((media.type === 'video' || media.type === 'gif') && media.url) {
            const item = {
              type: media.type,
              url: media.url,
              download_url: media.url,
              thumbnail_url: media.thumbnail_url,
              duration: media.duration,
              width: media.width,
              height: media.height,
              size: `${media.width}x${media.height}`,
              variants: [],
            };
            
            item.variants = [{
              url: media.url,
              quality: getQualityFromResolution(`${media.width}x${media.height}`),
              resolution: `${media.width}x${media.height}`
            }];
            
            result.media.push(item);
          }
        });
        
        return result;
      }
    }
  } catch (error) {
    // Silent error
  }
  return null;
}

async function fetchViaHTMLScraping(tweetId) {
  try {
    const response = await fetch(`https://twitter.com/i/web/status/${tweetId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });
    
    if (response.ok) {
      const html = await response.text();
      const videoVariants = extractAllVideoVariantsFromHTML(html);
      
      if (videoVariants.length > 0) {
        const result = {
          method: 'api_c',
          user: {
            name: 'Unknown',
            screen_name: 'unknown',
            profile_image_url: '',
          },
          text: 'Extracted content',
          created_at: new Date().toISOString(),
          media: [],
        };
        
        const groupedVariants = {};
        videoVariants.forEach(variant => {
          const videoIdMatch = variant.url.match(/amplify_video\/(\d+)/);
          const videoId = videoIdMatch ? videoIdMatch[1] : 'unknown';
          if (!groupedVariants[videoId]) {
            groupedVariants[videoId] = [];
          }
          groupedVariants[videoId].push(variant);
        });
        
        Object.values(groupedVariants).forEach(variants => {
          if (variants.length > 0) {
            variants.sort((a, b) => {
              const resA = parseResolution(a.resolution);
              const resB = parseResolution(b.resolution);
              return (resB.width * resB.height) - (resA.width * resA.height);
            });
            
            const bestVariant = variants[0];
            result.media.push({
              type: 'video',
              url: bestVariant.url,
              download_url: bestVariant.url,
              thumbnail_url: '',
              variants: variants,
              best_quality: bestVariant.quality,
              available_qualities: [...new Set(variants.map(v => v.quality))],
              available_resolutions: [...new Set(variants.map(v => v.resolution))],
            });
          }
        });
        
        if (result.media.length > 0) {
          return result;
        }
      }
    }
  } catch (error) {
    // Silent error
  }
  return null;
}

// =========================
//   HELPER FUNCTIONS
// =========================
function extractAllVideoVariantsFromHTML(html) {
  const variants = [];
  const seenUrls = new Set();
  
  const videoPatterns = [
    /https:\/\/video\.twimg\.com\/[^"\'\s]*\.mp4/g,
    /https:\/\/video\.twimg\.com\/amplify_video\/\d+\/[^"\'\s]*\.mp4/g,
    /https:\/\/video\.twimg\.com\/ext_tw_video\/\d+\/[^"\'\s]*\.mp4/g,
    /https:\/\/video\.twimg\.com\/tweet_video\/[^"\'\s]*\.mp4/g,
  ];
  
  videoPatterns.forEach(pattern => {
    const matches = html.match(pattern) || [];
    matches.forEach(url => {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        
        const resolutionMatch = url.match(/\/(\d+)x(\d+)\//);
        let resolution = 'unknown';
        if (resolutionMatch) {
          resolution = `${resolutionMatch[1]}x${resolutionMatch[2]}`;
        }
        
        variants.push({
          url: url,
          resolution: resolution,
          quality: getQualityFromResolution(resolution),
          content_type: 'video/mp4',
        });
      }
    });
  });
  
  return variants;
}

async function enhanceMediaWithResolutions(mediaItems, tweetId) {
  return mediaItems.map(item => {
    if (item.type === 'video' || item.type === 'gif') {
      if (!item.variants || item.variants.length === 0) {
        const resolution = getResolutionFromUrl(item.url) || item.size || 'unknown';
        item.variants = [{
          url: item.url,
          quality: getQualityFromResolution(resolution),
          resolution: resolution,
        }];
      }
      
      item.variants.sort((a, b) => {
        const resA = parseResolution(a.resolution);
        const resB = parseResolution(b.resolution);
        const pixelsA = resA.width * resA.height;
        const pixelsB = resB.width * resB.height;
        return pixelsB - pixelsA;
      });
      
      if (item.variants.length > 0) {
        item.url = item.variants[0].url;
        item.download_url = item.variants[0].url;
        item.best_quality = item.variants[0].quality;
        item.available_qualities = [...new Set(item.variants.map(v => v.quality).filter(q => q && q !== 'unknown'))];
        item.available_resolutions = [...new Set(item.variants.map(v => v.resolution).filter(r => r && r !== 'unknown'))];
      }
    }
    
    return item;
  });
}

function getQualityFromResolution(resolution) {
  if (!resolution || resolution === 'unknown' || resolution === 'undefinedxundefined') return 'unknown';
  
  const [width, height] = resolution.split('x').map(Number);
  
  if (isNaN(width) || isNaN(height)) return 'unknown';
  
  if (width === 480 && height === 270) return '480p';
  if (width === 640 && height === 360) return '360p';
  if (width === 854 && height === 480) return '480p';
  if (width === 1280 && height === 720) return '720p';
  if (width === 1920 && height === 1080) return '1080p';
  if (width === 2560 && height === 1440) return '1440p';
  if (width === 3840 && height === 2160) return '4K';
  
  if (width >= 3840 || height >= 2160) return '4K';
  if (width >= 2560 || height >= 1440) return '1440p';
  if (width >= 1920 || height >= 1080) return '1080p';
  if (width >= 1280 || height >= 720) return '720p';
  if (width >= 854 || height >= 480) return '480p';
  if (width >= 640 || height >= 360) return '360p';
  
  return 'unknown';
}

function getResolutionFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/(\d+)x(\d+)\//);
  return match ? `${match[1]}x${match[2]}` : null;
}

function parseResolution(resolution) {
  if (!resolution || resolution === 'unknown' || resolution === 'undefinedxundefined') {
    return { width: 0, height: 0 };
  }
  const parts = resolution.split('x').map(Number);
  return {
    width: parts[0] || 0,
    height: parts[1] || 0
  };
}

function extractStatusIdFromUrl(urlString) {
  const match = urlString.match(/\d{10,}/);
  return match ? match[0] : null;
}

function generateDownloadInfo(mediaData, tweetId) {
  const user = mediaData.user || {};
  const date = new Date(mediaData.created_at || new Date());
  const formattedDate = date.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .split('.')[0];
  
  const cleanName = (str) => (str || 'unknown')
    .replace(/[\\/:*?"<>|]/g, '_')
    .substring(0, 50);
  
  const userScreenName = user.screen_name || 'unknown';
  const userName = user.name || 'Unknown';
  
  let totalVariants = 0;
  let availableQualities = new Set();
  let availableResolutions = new Set();
  
  mediaData.media.forEach(item => {
    if (item.variants) {
      totalVariants += item.variants.length;
      item.variants.forEach(v => {
        if (v.quality && v.quality !== 'unknown') {
          availableQualities.add(v.quality);
        }
        if (v.resolution && v.resolution !== 'unknown') {
          availableResolutions.add(v.resolution);
        }
      });
    }
  });
  
  const sortedQualities = Array.from(availableQualities).sort((a, b) => {
    const qualityOrder = { '4K': 6, '1440p': 5, '1080p': 4, '720p': 3, '480p': 2, '360p': 1 };
    return (qualityOrder[b] || 0) - (qualityOrder[a] || 0);
  });
  
  const sortedResolutions = Array.from(availableResolutions).sort((a, b) => {
    const resA = parseResolution(a);
    const resB = parseResolution(b);
    return (resB.width * resB.height) - (resA.width * resA.height);
  });
  
  return {
    id: tweetId,
    user_name: cleanName(userName),
    user_id: userScreenName,
    date_time: formattedDate,
    media_count: mediaData.media.length,
    total_files: mediaData.media.length,
    total_variants: totalVariants,
    highest_quality: sortedQualities[0] || 'unknown',
    available_qualities: sortedQualities,
    available_resolutions: sortedResolutions,
    suggested_filenames: {
      default: `content_${cleanName(userName)}_${tweetId}`,
      simple: `${userScreenName}_${tweetId}`,
      with_date: `${formattedDate}_${userScreenName}_${tweetId}`,
    },
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders('application/json'),
  });
}

function corsHeaders(contentType = null) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  
  return headers;
}

async function handleScrapeRequest(request) {
  try {
    const { url } = await request.json();
    return await handleScrapeRequestDirect(url);
  } catch (error) {
    return jsonResponse({ 
      success: false, 
      error: 'Invalid request' 
    }, 400);
  }
}