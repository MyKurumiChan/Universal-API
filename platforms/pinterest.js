export default {
  async fetch(request) {
    const url = new URL(request.url);

    /* ===============================
       DOWNLOAD ENDPOINT (FIXED)
       =============================== */
    if (url.pathname === "/download") {
      const mediaUrl = url.searchParams.get("u");
      if (!mediaUrl) {
        return new Response("Missing media URL", { status: 400 });
      }

      try {
        const mediaRes = await fetch(mediaUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        // ⚠️ IMPORTANT FIX:
        // Use arrayBuffer instead of streaming
        const buffer = await mediaRes.arrayBuffer();

        return new Response(buffer, {
          headers: {
            "Content-Type":
              mediaRes.headers.get("Content-Type") ||
              "application/octet-stream",
            "Access-Control-Allow-Origin": "*"
          }
        });

      } catch {
        return new Response("Download failed", { status: 500 });
      }
    }

    /* ===============================
       PINTEREST JSON API
       =============================== */
    const pinUrl = url.searchParams.get("url");
    if (!pinUrl) {
      return json({ success: false, error: "URL_REQUIRED" }, 400);
    }

    try {
      const upstream = await fetch(
        `https://pntdl.vercel.app/api/download?url=${encodeURIComponent(pinUrl)}`,
        {
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        }
      );

      const text = await upstream.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch {
        return json({ success: false, error: "UPSTREAM_NOT_JSON" }, 502);
      }

      if (!data.success || !data.data?.medias) {
        return json({ success: false, error: "NO_MEDIA" }, 502);
      }

      return json({
        success: true,
        title: data.title || "",
        medias: data.data.medias
      });

    } catch {
      return json({ success: false, error: "WORKER_FAILED" }, 500);
    }
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
