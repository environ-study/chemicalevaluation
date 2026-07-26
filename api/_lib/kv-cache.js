/* ============================================================
   api/_lib/kv-cache.js — 업스트림 조회 결과 캐시 (Vercel KV)
   ─────────────────────────────────────────────────────────
   원칙(스펙 4번):
     1. 성공 응답(success:true)만 캐시한다.
     2. 오류 객체는 절대 저장하지 않는다.
     3. KV 자체가 장애여도 조회 흐름을 막지 않고 업스트림 재조회로 폴백한다.
   ============================================================ */

const { kv } = require('@vercel/kv');

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24시간 — 규제 데이터는 일 단위로도 충분

async function getCached(key) {
  try {
    return await kv.get(key);
  } catch {
    return null; // KV 장애 시 캐시 미스로 취급 → 업스트림 재조회
  }
}

async function setCachedSuccess(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!value || value.success !== true) return; // 성공이 아니면 저장 금지
  try {
    await kv.set(key, value, { ex: ttlSeconds });
  } catch {
    // 캐시 저장 실패는 무시 — 이미 조회에는 성공했으므로 응답 자체에는 영향 없음
  }
}

async function deleteCached(key) {
  try {
    await kv.del(key);
  } catch {
    // 무시
  }
}

module.exports = { getCached, setCachedSuccess, deleteCached, DEFAULT_TTL_SECONDS };
