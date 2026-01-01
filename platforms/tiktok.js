// TikTok Downloader with oEmbed thumbnail
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  
  if (request.method === 'OPTIONS') {
      return new Response(null, {
          headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type'
          }
      })
  }
  
  if (url.pathname === '/api/tiktok') {
      return handleTikTokDownload(request)
  }
  
  if (url.pathname === '/api/status') {
      return new Response(JSON.stringify({
          success: true,
          message: 'API Ready',
          version: '3.0'
      }), {
          headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
          }
      })
  }
  
  return new Response(JSON.stringify({
      success: false,
      error: 'Not found'
  }), { status: 404, headers: corsHeaders() })
}

function corsHeaders() {
  return {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
  }
}

async function handleTikTokDownload(request) {
  try {
      let tiktokUrl = ''
      
      if (request.method === 'GET') {
          const url = new URL(request.url)
          tiktokUrl = url.searchParams.get('url')
      }
      
      if (!tiktokUrl) {
          return errorResponse('URL required', 400)
      }
      
      if (!isValidTikTokUrl(tiktokUrl)) {
          return errorResponse('Invalid TikTok URL', 400)
      }
      
      const videoId = extractVideoId(tiktokUrl)
      
      // Get video data in parallel
      const [tikData, oembedData] = await Promise.allSettled([
          fetchFromTikDownloader(tiktokUrl),
          fetchOEmbedData(tiktokUrl)
      ])
      
      // Merge data
      const result = await processVideoData(
          tikData.status === 'fulfilled' ? tikData.value : null,
          oembedData.status === 'fulfilled' ? oembedData.value : null,
          videoId,
          tiktokUrl
      )
      
      return new Response(JSON.stringify(result), {
          headers: corsHeaders()
      })
      
  } catch (error) {
      console.error('Error:', error)
      return errorResponse(error.message)
  }
}

function errorResponse(message, status = 500) {
  return new Response(JSON.stringify({
      success: false,
      error: message
  }), {
      status: status,
      headers: corsHeaders()
  })
}

async function fetchOEmbedData(tiktokUrl) {
  try {
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(tiktokUrl)}`
      
      const response = await fetch(oembedUrl, {
          headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
      })
      
      if (!response.ok) {
          throw new Error(`oEmbed error: ${response.status}`)
      }
      
      const data = await response.json()
      return {
          title: data.title || '',
          author: data.author_name || '',
          author_url: data.author_url || '',
          thumbnail: data.thumbnail_url || '',
          thumbnail_width: data.thumbnail_width || 0,
          thumbnail_height: data.thumbnail_height || 0,
          html: data.html || ''
      }
      
  } catch (error) {
      console.warn('oEmbed failed:', error.message)
      return null
  }
}

async function fetchFromTikDownloader(tiktokUrl) {
  const API_URL = "https://tikdownloader.io/api/ajaxSearch"
  
  const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://tikdownloader.io/",
      "Origin": "https://tikdownloader.io"
  }
  
  const formData = new URLSearchParams()
  formData.append('q', tiktokUrl)
  formData.append('lang', 'en')
  
  try {
      const response = await fetch(API_URL, {
          method: 'POST',
          headers: headers,
          body: formData
      })
      
      if (!response.ok) {
          throw new Error(`API error: ${response.status}`)
      }
      
      const data = await response.json()
      
      if (data.status !== 'ok' || !data.data) {
          throw new Error('Invalid response')
      }
      
      return processTikDownloaderResponse(data.data, tiktokUrl)
      
  } catch (error) {
      console.error('TikDownloader error:', error)
      throw error
  }
}

function processTikDownloaderResponse(html, url) {
  const links = []
  
  // Extract snapcdn links
  const snapcdnPattern = /href="(https:\/\/dl\.snapcdn\.app\/get\?token=[^"]+)"/gi
  let match
  
  while ((match = snapcdnPattern.exec(html)) !== null) {
      const link = match[1]
      links.push({
          url: link,
          quality: 'HD',
          type: 'video',
          source: 'snapcdn'
      })
  }
  
  // Get video sizes
  const linksWithSize = links.slice(0, 3) // Max 3 links
  
  return {
      links: linksWithSize,
      success: linksWithSize.length > 0
  }
}

async function processVideoData(tikData, oembedData, videoId, originalUrl) {
  const info = {
      title: oembedData?.title || 'TikTok Video',
      author: oembedData?.author || 'unknown',
      thumbnail: oembedData?.thumbnail || null,
      author_url: oembedData?.author_url || ''
  }
  
  // Get video sizes
  let links = tikData?.links || []
  if (links.length > 0) {
      links = await Promise.all(
          links.map(async (link, index) => {
              const size = await getVideoSize(link.url)
              return {
                  ...link,
                  size: size,
                  label: links.length > 1 ? `Quality ${index + 1}` : 'HD'
              }
          })
      )
  }
  
  return {
      success: links.length > 0,
      videoId: videoId,
      url: originalUrl,
      links: links,
      info: info,
      timestamp: Date.now()
  }
}

async function getVideoSize(url) {
  try {
      const response = await fetch(url, {
          method: 'HEAD',
          headers: {
              'User-Agent': 'Mozilla/5.0'
          }
      })
      
      if (response.ok) {
          const size = response.headers.get('content-length')
          if (size) {
              return formatFileSize(parseInt(size))
          }
      }
  } catch (error) {
      // Ignore size errors
  }
  return null
}

function formatFileSize(bytes) {
  if (!bytes) return null
  
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  
  while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

function isValidTikTokUrl(url) {
  return /tiktok\.com\/@[\w.-]+\/video\/\d+/.test(url) || 
         /(vm|vt)\.tiktok\.com\/[\w\d]+/.test(url)
}

function extractVideoId(url) {
  const match = url.match(/video\/(\d+)/)
  return match ? match[1] : null
}