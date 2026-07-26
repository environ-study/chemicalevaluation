/* ============================================================
   api/_lib/kreach-parse.js — 화평법 K-REACH 원문 조회 + 함량 판정
   ─────────────────────────────────────────────────────────
   BACK/api_kreach.py(구 Flask 백엔드)의 실제 검증된 파싱 로직을
   그대로 이식한다 (sbstnClsfTypeNm / contInfo / unqNo 구조).

   2단 구조:
     fetchKreachRaw()      — 업스트림 호출 + 원문 파싱 (캐시 대상, 함량 무관)
     applyContentJudgment()— 캐시된 raw 위에서 함량 판정만 수행 (무캐시, 순수함수)

   금지물질은 함량과 무관하게 최우선이므로 regulations[]에 넣지 않고
   최상위 prohibited/prohibitedReason으로 분리한다.
   기존화학물질(KE번호)도 규제 판정이 아니므로 existingChemical으로 분리하고
   regulations[]·사내 허가 대조 대상에서 완전히 제외한다.
   ============================================================ */

const { fetchWithRetry } = require('./http');

const KREACH_URL = 'https://apis.data.go.kr/B552584/kecoapi/ncissbstn/chemSbstnList';

// 인체등유해성물질 contInfo 파싱 키워드 ("인체급성유해성 : 10%" 등)
const HAZARD_PARSE_KW = [
  [/인체\s*급성/, '급성'],
  [/급성\s*유해/, '급성'],
  [/인체\s*만성/, '만성'],
  [/만성\s*유해/, '만성'],
  [/생태\s*유해/, '생태'],
  [/수생\s*유해/, '생태'],
];

function parseHazardContInfo(contInfo) {
  const result = {};
  if (!contInfo) return result;
  const segments = contInfo.split(/,\s*(?=[가-힣])/);
  for (const seg of segments) {
    const numMatch = seg.match(/:\s*(\d+(?:\.\d+)?)\s*%/);
    if (!numMatch) continue;
    const val = parseFloat(numMatch[1]);
    for (const [pattern, cat] of HAZARD_PARSE_KW) {
      if (pattern.test(seg)) {
        if (!(cat in result) || val < result[cat]) result[cat] = val;
        break;
      }
    }
  }
  return result;
}

// 사고대비물질 contInfo("톨루엔 및 이를 85% 이상 함유한 혼합물") → 85
function parseAccidentThresholdValue(contInfo) {
  if (!contInfo) return null;
  const m = contInfo.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

function emptyResult(cas) {
  return {
    success: true,
    casNo: cas,
    notFound: true,
    chemicalName: '',
    chemicalNameKor: '',
    chemicalNameEn: '',
    existingChemical: { matched: false, keNo: '' },
    prohibited: false,
    prohibitedReason: '',
    regulations: [],
    infoTags: [],
  };
}

/**
 * CAS 번호로 K-REACH 원문 조회 + 구조화(함량 판정은 하지 않음).
 * 실패 시 upstreamRes(응답) 또는 예외를 던져 호출부(api/kreach.js)가
 * classifyUpstreamFailure()로 사용자용 오류 응답을 만들도록 한다.
 */
async function fetchKreachRaw(casNo, apiKey) {
  const cas = (casNo || '').trim();
  if (!cas) return emptyResult(cas);

  const params = new URLSearchParams({
    serviceKey: apiKey,
    searchGubun: '2',
    searchNm: cas,
    pageNo: '1',
    numOfRows: '10',
    returnType: 'JSON',
  });

  const res = await fetchWithRetry(`${KREACH_URL}?${params.toString()}`);
  if (!res.ok) {
    const err = new Error(`K-REACH upstream HTTP ${res.status}`);
    err.upstreamRes = res;
    throw err;
  }

  let body;
  try {
    const json = await res.json();
    body = json.body || {};
  } catch (e) {
    const err = new Error('K-REACH 응답이 올바른 JSON이 아닙니다');
    throw err;
  }

  let items = body.items || [];
  if (items && !Array.isArray(items)) items = [items];
  if (!items.length) return emptyResult(cas);

  const item = items[0];
  const typeListRaw = item.typeList || [];
  const typeList = Array.isArray(typeListRaw) ? typeListRaw : [typeListRaw];

  const nameKor = (item.sbstnNmKor || '').trim();
  const nameEn = (item.sbstnNmEng || '').trim();

  const result = {
    success: true,
    casNo: cas,
    notFound: false,
    chemicalName: nameKor || nameEn || '',
    chemicalNameKor: nameKor,
    chemicalNameEn: nameEn,
    existingChemical: { matched: false, keNo: '' },
    prohibited: false,
    prohibitedReason: '',
    regulations: [],
    infoTags: [],
  };

  const hazardCriteria = {}; // { 급성|만성|생태 : { value } }
  let hazardUnqNo = '';
  let hazardExcp = '';

  for (const t of typeList) {
    const nm = t.sbstnClsfTypeNm || '';
    const cont = (t.contInfo || '').trim();
    const excp = (t.excpInfo || '').trim();
    const unq = (t.unqNo || '').trim();

    if (nm.includes('인체등유해성물질')) {
      const parsed = parseHazardContInfo(cont);
      for (const cat of Object.keys(parsed)) {
        const val = parsed[cat];
        if (!(cat in hazardCriteria) || val < hazardCriteria[cat].value) {
          hazardCriteria[cat] = { value: val };
        }
      }
      if (unq) hazardUnqNo = unq;
      if (excp) hazardExcp = excp;
      continue;
    }

    if (nm.includes('기존화학물질') && unq) {
      result.existingChemical = { matched: true, keNo: unq };
      continue;
    }

    if (nm.includes('금지물질')) {
      result.prohibited = true;
      result.prohibitedReason = excp || '금지물질';
      continue;
    }

    if (nm.includes('사고대비물질')) {
      const thr = parseAccidentThresholdValue(cont);
      result.regulations.push({
        type: '사고대비물질',
        hazardCategory: null,
        thresholdValue: thr,
        criterion: thr != null ? `≥${thr}%` : null,
        uniqueNo: unq || null,
      });
      continue;
    }

    if (nm.includes('유독물질') || nm.includes('허가물질') || nm.includes('제한물질')) {
      const label = nm.includes('유독물질') ? '유독물질' : nm.includes('허가물질') ? '허가물질' : '제한물질';
      result.regulations.push({
        type: label,
        hazardCategory: null,
        thresholdValue: null, // 함량 무관 — 해당 시 항상 규제대상
        criterion: null,
        uniqueNo: unq || null,
      });
      continue;
    }

    if (nm.includes('등록대상기존화학물질') || nm.includes('등록대상')) {
      result.infoTags.push({ type: '등록대상기존화학물질' });
      continue;
    }

    if (nm.includes('중점관리물질')) {
      result.infoTags.push({ type: '중점관리물질' });
      continue;
    }
    // 그 외(로테르담협약물질 등)는 구매판정과 무관하므로 무시
  }

  Object.keys(hazardCriteria).forEach((cat) => {
    const info = hazardCriteria[cat];
    result.regulations.push({
      type: '인체등유해성물질',
      hazardCategory: cat,
      thresholdValue: info.value,
      criterion: `≥${info.value}%`,
      uniqueNo: hazardUnqNo || null,
    });
  });
  if (hazardExcp) result.hazardExceptionNote = hazardExcp;

  return result;
}

/** 기준값이 없으면(함량 무관 규제) 항상 해당, 있으면 미만/이하를 반영해 비교 */
function isThresholdExceeded(thresholdValue, contentMax, isLt) {
  if (thresholdValue == null) return true;
  if (contentMax == null) return false;
  return isLt ? contentMax > thresholdValue : contentMax >= thresholdValue;
}

/**
 * 캐시된 raw 결과 위에서 함량 판정(matchedByContent)만 계산하는 순수 함수.
 * 업스트림 호출이 없으므로 캐시하지 않고 매 요청마다 실행한다.
 */
function applyContentJudgment(raw, contentMax, isLt) {
  if (!raw || raw.success !== true) return raw;
  const regulations = (raw.regulations || []).map((r) => ({
    ...r,
    matchedByContent: isThresholdExceeded(r.thresholdValue, contentMax, !!isLt),
  }));
  return {
    ...raw,
    regulations,
    contentMax: contentMax != null ? contentMax : null,
    isLt: !!isLt,
  };
}

module.exports = {
  KREACH_URL,
  fetchKreachRaw,
  applyContentJudgment,
  parseHazardContInfo,
  parseAccidentThresholdValue,
};
