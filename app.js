(function () {
  var C = window.APP_CONFIG, $ = function (id) { return document.getElementById(id); };
  var msg = function (t, cls) { var m = $("msg"); m.textContent = t; m.className = cls || ""; };
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };
  var token = store.get("tt_token");

  $("connect").onclick = function () {
    var state = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    store.set("tt_state", state);
    location.href = "https://www.tiktok.com/v2/auth/authorize/?" + new URLSearchParams({
      client_key: C.clientKey, scope: C.scope, response_type: "code", redirect_uri: C.redirectUri, state: state
    });
  };
  $("logout").onclick = function () { store.del("tt_token"); location.reload(); };

  function api(path, opts) {
    opts = opts || {}; opts.headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
    return fetch(C.worker + path, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }

  if (token) {
    $("step1").classList.add("hide"); $("step2").classList.remove("hide");
    api("/api/user").then(function (u) {
      $("name").textContent = u.display_name || "your account";
      if (u.avatar_url) { $("avatar").src = u.avatar_url; $("avatar").classList.remove("hide"); }
    }).catch(function () { store.del("tt_token"); msg("Session expired. Please connect again.", "err"); $("step1").classList.remove("hide"); $("step2").classList.add("hide"); });
  }
  if (store.get("tt_flash")) { msg(store.get("tt_flash"), "ok"); store.del("tt_flash"); }

  $("file").onchange = function () { $("send").disabled = !this.files.length; };
  $("send").onclick = function () {
    var f = $("file").files[0]; if (!f) return;
    if (f.size > 64 * 1024 * 1024) { msg("File is larger than 64 MB.", "err"); return; }
    $("send").disabled = true; msg("Uploading to TikTok…");
    api("/api/upload", { method: "POST", body: f, headers: { "Content-Type": "video/mp4" } }).then(function (r) {
      var tries = 0;
      (function poll() {
        api("/api/status?publish_id=" + encodeURIComponent(r.publish_id)).then(function (s) {
          if (s.status === "SEND_TO_USER_INBOX" || s.status === "PUBLISH_COMPLETE") msg("Done. The video is now a draft in your TikTok inbox. Open the TikTok app to review and publish it.", "ok");
          else if (s.status === "FAILED") msg("TikTok reported a failure: " + (s.fail_reason || "unknown"), "err");
          else if (++tries < 30) { msg("TikTok is processing the video… (" + (s.status || "pending") + ")"); setTimeout(poll, 3000); }
          else msg("Still processing. Check your TikTok inbox in a moment.");
        }).catch(function (e) { msg("Status check failed: " + e.message, "err"); });
      })();
    }).catch(function (e) { msg("Upload failed: " + e.message, "err"); $("send").disabled = false; });
  };
})();
