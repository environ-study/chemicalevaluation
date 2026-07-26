/* ============================================================
   api/_lib/normalize.js — CAS / 유해화학물질 고유번호 정규화 (Node 측)
   ─────────────────────────────────────────────────────────
   원래 프로젝트 루트의 shared/normalize.js를 브라우저·서버 공용으로
   쓰려 했으나, 배포 환경에서 루트 밖 정적 파일(shared/) 서빙이
   누락되어 프론트엔드 로드 실패 + 서버리스 함수 require 실패가
   동시에 발생했다. api/_lib 트리 안으로 옮겨 배포 신뢰성을 높인다
   (브라우저용 로직은 app.js 상단에 직접 인라인되어 있음 — 두 사본을
   동기화할 때는 이 파일과 app.js 상단을 함께 수정할 것).
   ============================================================ */

function normalizeCas(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
}

function isValidCasFormat(cas) {
  return /^\d{2,7}-\d{2}-\d$/.test(normalizeCas(cas));
}

function normalizeUniqueNo(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, '').toUpperCase();
}

function isKeNumber(str) {
  return /^KE-/i.test(String(str == null ? '' : str).trim());
}

function compositeKey(cas, uniqueNo) {
  return normalizeCas(cas) + '|' + normalizeUniqueNo(uniqueNo);
}

module.exports = { normalizeCas, isValidCasFormat, normalizeUniqueNo, isKeNumber, compositeKey };
