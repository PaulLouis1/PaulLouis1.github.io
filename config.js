// Public values only (the client secret lives in the Cloudflare Worker, never here).
window.APP_CONFIG = {
  clientKey: "awwbfzll6q2ovigu",
  worker: "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
  redirectUri: "https://paullouis1.github.io/callback.html",
  scope: "user.info.basic,video.upload"
};
