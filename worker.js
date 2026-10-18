/**
 * MyPresence FCM Notification Worker
 * ===================================
 * Menggantikan Cloud Functions `processNotificationQueue` (butuh Blaze plan).
 *
 * VERSI: kredensial tertanam langsung (tidak perlu set secrets manual).
 * Cukup paste seluruh file ini ke Cloudflare Workers → Save and deploy.
 *
 * Cara kerja:
 * 1. Cron trigger tiap 1 menit
 * 2. Baca notification_queue/{companyId} dari RTDB mypresence-prod
 * 3. Untuk setiap item status="pending":
 *    - Ambil FCM tokens dari companies/{companyId}/users/{uid}/fcm_tokens
 *    - Kirim via FCM HTTP v1 API
 *    - Update status jadi "sent" / "failed"
 *
 * Cron: * * * * * (tiap menit)
 */

// ============ KONFIGURASI ============
// Kredensial dibaca dari Secrets (Settings → Variables and Secrets):
//   FIREBASE_PROJECT_ID, FIREBASE_DATABASE_URL,
//   FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// ============ AKHIR KONFIGURASI ============

// ---------- JWT & OAuth2 ----------

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let b64 = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(env) {
  const pem = env.FIREBASE_PRIVATE_KEY;
  const pemBody = pem
    .replace(/\\n/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  // Diagnostik: simpan info untuk error reporting
  globalThis._keyDebug = {
    rawLen: pem.length,
    cleanLen: pemBody.length,
    divBy4: pemBody.length % 4 === 0,
    first20: pemBody.substring(0, 20),
    last20: pemBody.substring(pemBody.length - 20),
  };
  const binary = Uint8Array.from(atob(pemBody), (ch) => ch.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64UrlEncode(
    JSON.stringify({
      iss: env.FIREBASE_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const key = await importPrivateKey(env);
  const sigBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`));
  const sigBytes = new Uint8Array(sigBuffer);
  let b64 = "";
  for (let i = 0; i < sigBytes.length; i += 0x8000) {
    b64 += String.fromCharCode.apply(null, sigBytes.subarray(i, i + 0x8000));
  }
  const signature = btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${claim}.${signature}`,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`OAuth token gagal: HTTP ${res.status} - ${errBody.substring(0, 500)}`);
  }
  const data = await res.json();
  return data.access_token;
}

// ---------- RTDB helpers ----------

async function rtdbGet(token, path) {
  const url = `${env.FIREBASE_DATABASE_URL}/${path}.json?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RTDB GET ${path}: HTTP ${res.status}`);
  return res.json();
}

async function rtdbPatch(token, path, data) {
  const url = `${env.FIREBASE_DATABASE_URL}/${path}.json?access_token=${token}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`RTDB PATCH ${path}: HTTP ${res.status}`);
  return res.json();
}

// ---------- FCM ----------

async function sendFcm(env, oauthToken, fcmToken, title, body, data = {}) {
  const url = `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        android: { priority: "high" },
        apns: { headers: { "apns-priority": "10" } },
      },
    }),
  });
  const result = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, result };
}

// ---------- Main processor ----------

async function processQueue(env) {
  const oauthToken = await getAccessToken(env);
  const summary = { checked: 0, sent: 0, failed: 0, skipped: 0 };

  // Ambil daftar companies
  const companies = (await rtdbGet(oauthToken, "companies")) || {};

  for (const companyId of Object.keys(companies)) {
    const queue = (await rtdbGet(oauthToken, `companies/${companyId}/notification_queue`)) || {};

    for (const [queueId, item] of Object.entries(queue)) {
      if (!item || typeof item !== "object") continue;
      summary.checked++;

      if (item.status !== "pending") {
        summary.skipped++;
        continue;
      }

      const uid = String(item.uid || "").trim();
      const title = String(item.title || "MYPRESENCE").trim();
      const body = String(item.body || item.message || "Ada notifikasi baru.").trim();

      if (!uid) {
        await rtdbPatch(oauthToken, `companies/${companyId}/notification_queue/${queueId}`, {
          status: "failed",
          error: "uid kosong",
          failed_at: Date.now(),
        });
        summary.failed++;
        continue;
      }

      // Ambil token aktif user
      const tokensNode = (await rtdbGet(oauthToken, `companies/${companyId}/users/${uid}/fcm_tokens`)) || {};
      const activeTokens = Object.values(tokensNode)
        .filter((t) => t && t.active !== false && t.token)
        .map((t) => t.token);

      if (activeTokens.length === 0) {
        await rtdbPatch(oauthToken, `companies/${companyId}/notification_queue/${queueId}`, {
          status: "failed",
          error: "tidak ada token FCM aktif",
          token_count: 0,
          failed_at: Date.now(),
        });
        summary.failed++;
        continue;
      }

      // Kirim ke semua token
      let successCount = 0;
      let failedCount = 0;
      const invalidTokens = [];

      for (const fcmToken of activeTokens) {
        try {
          const { ok, result } = await sendFcm(env, oauthToken, fcmToken, title, body, {
            type: item.type || "info",
            ref_type: item.ref_type || "",
            ref_id: item.ref_id || "",
            queue_id: queueId,
          });
          if (ok) {
            successCount++;
          } else {
            failedCount++;
            const errCode = result?.error?.details?.[0]?.errorCode || result?.error?.message || "";
            if (errCode.includes("UNREGISTERED") || errCode.includes("INVALID_ARGUMENT")) {
              invalidTokens.push(fcmToken);
            }
          }
        } catch (e) {
          failedCount++;
        }
      }

      // Nonaktifkan token yang invalid
      for (const badToken of invalidTokens) {
        const tokenId = [...Object.entries(tokensNode)].find(([, v]) => v && v.token === badToken)?.[0];
        if (tokenId) {
          await rtdbPatch(oauthToken, `companies/${companyId}/users/${uid}/fcm_tokens/${tokenId}`, { active: false, updated_at: Date.now() }).catch(() => {});
        }
      }

      const nowMs = Date.now();
      if (successCount > 0) {
        await rtdbPatch(oauthToken, `companies/${companyId}/notification_queue/${queueId}`, {
          status: "sent",
          token_count: activeTokens.length,
          success_count: successCount,
          failed_count: failedCount,
          error: failedCount > 0 ? `${failedCount} token gagal` : null,
          sent_at: nowMs,
        });
        summary.sent++;
      } else {
        const retryCount = (item.retry_count || 0) + 1;
        const maxRetry = 3;
        await rtdbPatch(oauthToken, `companies/${companyId}/notification_queue/${queueId}`, {
          status: retryCount >= maxRetry ? "failed" : "pending",
          retry_count: retryCount,
          token_count: activeTokens.length,
          success_count: 0,
          failed_count: failedCount,
          error: "semua token gagal dikirim",
          failed_at: retryCount >= maxRetry ? nowMs : item.failed_at || null,
        });
        summary.failed++;
      }
    }
  }

  return summary;
}

export default {
  async scheduled(event, env, ctx) {
    try {
      const summary = await processQueue(env);
      console.log("FCM Worker selesai:", JSON.stringify(summary));
    } catch (e) {
      console.error("FCM Worker error:", e.message);
    }
  },

  // Endpoint manual untuk test: GET /?test=1
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("test") === "1") {
      try {
        // Diagnostik: cek secrets tersedia
        const envKeys = Object.keys(env || {});
        const hasKey = !!env.FIREBASE_PRIVATE_KEY;
        const keyLen = hasKey ? env.FIREBASE_PRIVATE_KEY.length : 0;
        const summary = await processQueue(env);
        return new Response(JSON.stringify({ envKeys, hasKey, keyLen, ...summary }, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack, keyDebug: globalThis._keyDebug }, null, 2), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("MyPresence FCM Worker aktif. Tambahkan ?test=1 untuk proses manual.", { headers: { "Content-Type": "text/plain" } });
  },
};
