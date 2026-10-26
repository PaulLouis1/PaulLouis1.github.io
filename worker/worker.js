// Cloudflare Worker: small backend for the TikTok Login Kit + Content Posting API (inbox/draft upload).
// Needed because the client secret must never be in the browser.
// Variables to set in Cloudflare (Settings > Variables and Secrets):
//   TIKTOK_CLIENT_KEY      (text)
//   TIKTOK_CLIENT_SECRET   (secret)
//   BOT_KEY               (secret)  password for the scheduled uploader (/api/bot/token)
// KV namespace binding (Settings > Bindings > KV namespace): variable name TOKENS
// The first account that logs in becomes the "owner"; its refresh token is kept in KV so the scheduled
// uploader can get fresh access tokens. Videos and access tokens are never stored.

const ALLOWED_ORIGIN = "https://paullouis1.github.io";
const REDIRECT_URI = "https://paullouis1.github.io/callback.html";
const TT = "https://open.tiktokapis.com";
const MAX_BYTES = 64 * 1024 * 1024; // single-chunk upload limit

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
    ...extra,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: cors({ "Content-Type": "application/json; charset=UTF-8" }),
  });
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (request.headers.get("Origin") && request.headers.get("Origin") !== ALLOWED_ORIGIN) {
      return json({ error: "origin_not_allowed" }, 403);
    }

    try {
      // 1) authorization code -> access token
      if (url.pathname === "/api/token" && request.method === "POST") {
        const { code } = await request.json();
        if (!code) return json({ error: "missing_code" }, 400);
        const res = await fetch(`${TT}/v2/oauth/token/`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key: env.TIKTOK_CLIENT_KEY,
            client_secret: env.TIKTOK_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: REDIRECT_URI,
          }),
        });
        const data = await readJson(res);
        if (!res.ok || data.error) return json({ error: data.error || "token_failed", detail: data.error_description }, 400);
        if (env.TOKENS && data.refresh_token && data.open_id) {
          const owner = await env.TOKENS.get("owner", "json");
          if (!owner || owner.open_id === data.open_id) {
            await env.TOKENS.put("owner", JSON.stringify({ open_id: data.open_id, refresh_token: data.refresh_token }));
          }
        }
        return json({ access_token: data.access_token, expires_in: data.expires_in, scope: data.scope });
      }

      // 1b) scheduled uploader: fresh access token from the stored refresh token
      if (url.pathname === "/api/bot/token" && request.method === "POST") {
        const given = request.headers.get("X-Bot-Key") || "";
        if (!env.BOT_KEY || !env.TOKENS || !safeEqual(given, env.BOT_KEY)) return json({ error: "forbidden" }, 403);
        const owner = await env.TOKENS.get("owner", "json");
        if (!owner) return json({ error: "no_owner_logged_in" }, 404);
        const res = await fetch(`${TT}/v2/oauth/token/`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key: env.TIKTOK_CLIENT_KEY,
            client_secret: env.TIKTOK_CLIENT_SECRET,
            grant_type: "refresh_token",
            refresh_token: owner.refresh_token,
          }),
        });
        const data = await readJson(res);
        if (!res.ok || data.error || !data.access_token) {
          return json({ error: data.error || "refresh_failed", detail: data.error_description }, 400);
        }
        if (data.refresh_token && data.refresh_token !== owner.refresh_token) {
          await env.TOKENS.put("owner", JSON.stringify({ open_id: owner.open_id, refresh_token: data.refresh_token }));
        }
        return json({ access_token: data.access_token, expires_in: data.expires_in });
      }

      // 2) who is logged in (user.info.basic)
      if (url.pathname === "/api/user" && request.method === "GET") {
        const res = await fetch(`${TT}/v2/user/info/?fields=open_id,display_name,avatar_url`, {
          headers: { Authorization: `Bearer ${bearer(request)}` },
        });
        const data = await readJson(res);
        const u = data.data && data.data.user;
        if (!res.ok || !u) return json({ error: "user_failed", detail: data.error }, 400);
        return json({ display_name: u.display_name, avatar_url: u.avatar_url });
      }

      // 3) upload video to the TikTok inbox as a draft (video.upload)
      if (url.pathname === "/api/upload" && request.method === "POST") {
        const token = bearer(request);
        if (!token) return json({ error: "missing_token" }, 401);
        const body = await request.arrayBuffer();
        const size = body.byteLength;
        if (!size) return json({ error: "empty_file" }, 400);
        if (size > MAX_BYTES) return json({ error: "file_too_large", max_mb: 64 }, 413);

        const init = await fetch(`${TT}/v2/post/publish/inbox/video/init/`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({
            source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
          }),
        });
        const initData = await readJson(init);
        if (!init.ok || !initData.data || !initData.data.upload_url) {
          return json({ error: "init_failed", detail: initData.error }, 400);
        }
        const put = await fetch(initData.data.upload_url, {
          method: "PUT",
          headers: {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes 0-${size - 1}/${size}`,
          },
          body,
        });
        if (!put.ok) return json({ error: "upload_failed", status: put.status }, 502);
        return json({ publish_id: initData.data.publish_id });
      }

      // 4) status of the upload
      if (url.pathname === "/api/status" && request.method === "GET") {
        const id = url.searchParams.get("publish_id");
        if (!id) return json({ error: "missing_publish_id" }, 400);
        const res = await fetch(`${TT}/v2/post/publish/status/fetch/`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer(request)}`, "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ publish_id: id }),
        });
        const data = await readJson(res);
        return json({
          http: res.status,
          status: data.data && data.data.status,
          fail_reason: data.data && data.data.fail_reason,
          uploaded_bytes: data.data && data.data.uploaded_bytes,
          error: data.error && (data.error.code + ": " + data.error.message),
        });
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server_error", detail: String(e && e.message || e) }, 500);
    }
  },
};
