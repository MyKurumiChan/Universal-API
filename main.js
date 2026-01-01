import { handleTikTok } from "./platforms/tiktok.js";
import { handleTwitter } from "./platforms/twitter.js";
import { handlePinterest } from "./platforms/pinterest.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { platform, url } = req.query;

  if (!platform || !url) {
    return res.status(400).json({
      success: false,
      error: "platform and url are required"
    });
  }

  try {
    if (platform === "tiktok") {
      return res.json(await handleTikTok(url));
    }

    if (platform === "twitter") {
      return res.json(await handleTwitter(url));
    }

    if (platform === "pinterest") {
      return res.json(await handlePinterest(url));
    }

    return res.status(400).json({
      success: false,
      error: "Unsupported platform"
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message || "Internal error"
    });
  }
}
