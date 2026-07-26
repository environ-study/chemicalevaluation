/* ============================================================
   api/kosha.js — 산안법 KOSHA 조회 서버리스 함수
   ─────────────────────────────────────────────────────────
   GET /api/kosha?cas=108-88-3

   KOSHA 판정은 함량과 무관(금지/특별관리 등은 CAS 기준 고정)하므로
   전체 응답을 그대로 캐시한다(성공 시에만, TTL 24h).
   ============================================================ */

const { fetchKoshaResult } = require('./_lib/kosha-parse');
const { getCachedSuccess, setCachedSuccess } = require('./_lib/kv-cache');
const { classifyUpstreamFailure, statusForErrorCode } = require('./_lib/http');
const { normalizeCas } = require('./_lib/normalize');

function firstValue(v) {
  return Array.isArray(v) ? v[0] : v;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({
      success: false,
      retryable: false,
      errorCode: 'METHOD_NOT_ALLOWED',
      message: 'GET만 지원합니다.',
    });
    return;
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    res.status(500).json({
      success: false,
      retryable: false,
      errorCode: 'SERVER_MISCONFIGURED',
      message: '서버 환경설정 오류입니다. 관리자에게 문의해 주세요.',
    });
    return;
  }

  const cas = normalizeCas(firstValue(req.query.cas));
  if (!cas) {
    res.status(400).json({
      success: false,
      retryable: false,
      errorCode: 'BAD_REQUEST',
      message: 'cas 파라미터가 필요합니다.',
    });
    return;
  }

  const cacheKey = `kosha:${cas}`;

  try {
    let result = await getCachedSuccess(cacheKey);
    if (!result) {
      result = await fetchKoshaResult(cas, apiKey);
      await setCachedSuccess(cacheKey, result);
    }
    res.status(200).json(result);
  } catch (err) {
    const payload = classifyUpstreamFailure(err, err && err.upstreamRes);
    console.error(`[api/kosha] cas=${cas} errorCode=${payload.errorCode}`);
    res.status(statusForErrorCode(payload.errorCode)).json(payload);
  }
};
