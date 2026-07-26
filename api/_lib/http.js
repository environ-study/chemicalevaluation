/* ============================================================
   api/_lib/http.js — 업스트림(공공데이터) 호출 공통 유틸
   ─────────────────────────────────────────────────────────
   - AbortController 기반 타임아웃
   - 429 / 5xx / 타임아웃 / 네트워크 오류는 최대 2회 재시도
     (약 500ms, 약 1500ms 대기 — 서버 함수 자체가 타임아웃되지
      않도록 대기시간을 짧게 유지한다)
   - 429는 Retry-After 헤더가 있으면 그 값을 우선 사용(최대 8초로 제한)
   - 4xx(429 제외)는 영구 오류로 간주해 즉시 반환(재시도하지 않음)
   - 오류를 사용자용 errorCode/message로 정리(내부 스택·API 키 노출 금지)
   - 실패/재시도 시 API 종류·CAS·상태코드만 로그로 남기고, URL 전체
     (serviceKey 쿼리 포함)나 응답 본문은 절대 로그에 남기지 않는다
   ============================================================ */

const DEFAULT_TIMEOUT_MS = 12000;
const RETRY_DELAYS_MS = [500, 1500]; // 1차, 2차 재시도 대기시간
const MAX_RETRY_AFTER_MS = 8000;      // Retry-After 헤더 상한(과도한 대기 방지)

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

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return null; // HTTP-date 형식 등은 지원하지 않고 기본 지연으로 폴백
}

/** API 키/URL 전체·응답 본문을 절대 남기지 않는 안전한 실패 로그 */
function logUpstreamFailure({ api, cas, status, errorCode, attempt, retrying }) {
  const parts = [
    `[upstream-fail] api=${api || '?'}`,
    `cas=${cas || '?'}`,
    status != null ? `status=${status}` : null,
    errorCode ? `errorCode=${errorCode}` : null,
    `attempt=${(attempt || 0) + 1}`,
    retrying ? 'retrying' : 'giving-up',
  ].filter(Boolean);
  console.warn(parts.join(' '));
}

/**
 * 429/5xx/타임아웃/네트워크 오류일 때만 최대 2회(약 500ms, 약 1500ms 대기 후) 재시도한다.
 * 4xx(429 제외)는 영구 오류로 간주해 즉시 응답을 그대로 반환한다(호출부가 res.ok로 판단).
 * context: { timeoutMs, api, cas } — api/cas는 로깅용, 응답에는 영향 없음.
 */
async function fetchWithRetry(url, options = {}, context = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, api = '', cas = '' } = context;
  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return res;

      const permanent = !isRetryableStatus(res.status);
      const isLastAttempt = attempt === maxAttempts - 1;

      if (permanent || isLastAttempt) {
        logUpstreamFailure({ api, cas, status: res.status, attempt, retrying: false });
        return res;
      }

      logUpstreamFailure({ api, cas, status: res.status, attempt, retrying: true });
      const wait = (res.status === 429 && retryAfterMs(res)) || RETRY_DELAYS_MS[attempt];
      await sleep(wait);
    } catch (e) {
      lastErr = e;
      const isTimeout = e && e.name === 'AbortError';
      const isLastAttempt = attempt === maxAttempts - 1;
      const errorCode = isTimeout ? 'TIMEOUT' : 'NETWORK';

      if (isLastAttempt) {
        logUpstreamFailure({ api, cas, errorCode, attempt, retrying: false });
        throw e;
      }
      logUpstreamFailure({ api, cas, errorCode, attempt, retrying: true });
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastErr; // 안전망 — 위 루프에서 항상 return/throw로 종료됨
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
  if (res && res.status >= 400) {
    return {
      success: false,
      retryable: false,
      errorCode: 'UPSTREAM_REQUEST_ERROR',
      message: '공공데이터 API 요청이 거부되었습니다. CAS 번호를 확인해 주세요.',
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
    case 'UPSTREAM_REQUEST_ERROR':
      return 502;
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
