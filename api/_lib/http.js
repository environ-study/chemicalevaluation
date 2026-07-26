/* ============================================================
   api/_lib/http.js — 업스트림(공공데이터) 호출 공통 유틸
   ─────────────────────────────────────────────────────────
   - AbortController 기반 타임아웃
   - 429 / 5xx / 타임아웃 발생 시 짧게 1회만 재시도
     (서버 함수 자체가 타임아웃되지 않도록 블로킹 재시도를 최소화하고,
      나머지 재시도는 클라이언트의 "재분석" 액션에 맡긴다)
   - 오류를 사용자용 errorCode/message로 정리(내부 스택·API 키 노출 금지)
   ============================================================ */

const DEFAULT_TIMEOUT_MS = 12000;
const RETRY_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 429/5xx/타임아웃이면 한 번만 짧게 재시도 후 반환한다.
 * fetch 자체가 던지는 예외(AbortError, 네트워크 오류)도 동일하게 1회 재시도.
 */
async function fetchWithRetry(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** fetch 예외(err) 또는 실패 응답(res)을 사용자용 오류 페이로드로 변환 */
function classifyUpstreamFailure(err, res) {
  if (err && err.name === 'AbortError') {
    return {
      success: false,
      retryable: true,
      errorCode: 'UPSTREAM_TIMEOUT',
      message: '공공데이터 API 응답이 지연되고 있습니다. 잠시 후 다시 분석해 주세요.',
    };
  }
  if (res && res.status === 429) {
    return {
      success: false,
      retryable: true,
      errorCode: 'UPSTREAM_RATE_LIMIT',
      message: '공공데이터 API 호출 한도를 초과했습니다. 잠시 후 다시 분석해 주세요.',
    };
  }
  if (res && res.status >= 500) {
    return {
      success: false,
      retryable: true,
      errorCode: 'UPSTREAM_SERVER_ERROR',
      message: '공공데이터 API가 일시적으로 응답하지 않습니다. 잠시 후 다시 분석해 주세요.',
    };
  }
  if (err) {
    return {
      success: false,
      retryable: true,
      errorCode: 'UPSTREAM_NETWORK_ERROR',
      message: '공공데이터 API 호출 중 네트워크 오류가 발생했습니다. 잠시 후 다시 분석해 주세요.',
    };
  }
  return {
    success: false,
    retryable: true,
    errorCode: 'UPSTREAM_ERROR',
    message: '공공데이터 API 조회 중 오류가 발생했습니다. 잠시 후 다시 분석해 주세요.',
  };
}

/** classifyUpstreamFailure()의 errorCode → 클라이언트에 내려줄 HTTP 상태코드 */
function statusForErrorCode(errorCode) {
  switch (errorCode) {
    case 'UPSTREAM_RATE_LIMIT':
      return 429;
    case 'UPSTREAM_TIMEOUT':
      return 504;
    default:
      return 502;
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  sleep,
  fetchWithTimeout,
  fetchWithRetry,
  classifyUpstreamFailure,
  statusForErrorCode,
};
