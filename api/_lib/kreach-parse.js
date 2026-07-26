/* ============================================================
   api/_lib/kreach-parse.js — 화평법 K-REACH 원문 조회 + 함량 판정
   ─────────────────────────────────────────────────────────
   BACK/api_kreach.py(구 Flask 백엔드)의 실제 검증된 파싱 로직을
   그대로 이식한다 (sbstnClsfTypeNm / contInfo / unqNo 구조).

   2단 구조:
     fetchKreachRaw()      — 업스트림 호출 + 원문 파싱 (캐시 대상, 함량 무관)
     applyContentJudgment()— 캐시된 raw 위에서 함량 판정만 수행 (무캐시, 순수함수)

   금지물질은 함량과 무관하게 최우선이므로 regulations[]에 넣지 않고
   최상위 prohibited/prohibitedReason/prohibitedUniqueNo/prohibitedSources로
   분리한다. 기존화학물질(korexst)도 규제 판정이 아니므로 existingChemical으로
   분리하고 regulations[]·사내 허가 대조 대상에서 완전히 제외한다.

   동일 CAS에 여러 item이 존재할 수 있으므로(예: 납 입자크기별 별도 item)
   검색된 모든 item의 typeList를 하나로 합쳐 통합 파싱한다. 화면에는
   규제유형별로 중복 제거한 스티커 1개만 노출하되, 원본 typeList 행은
   각 규제 항목의 sources[]에 전부 보존해 상세 팝업에서 확인할 수 있게 한다.
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

// 기준값 비교 연산자 텍스트 → 내부 연산자 기호. 명시가 없으면 "이상"(>=)이 기본.
const OPERATOR_SYMBOL = { '>=': '≥', '>': '>', '<=': '≤', '<': '<' };

function parseOperator(text) {
  if (/초과/.test(text)) return '>';
  if (/미만/.test(text)) return '<';
  if (/이하/.test(text)) return '<=';
  return '>=';
}

/**
 * contInfo 한 건에서 여러 구분(급성/만성/생태)이 함께 나올 수 있으므로
 * 배열로 반환한다. 각 항목은 { category, threshold, operator }.
 */
function parseHazardContInfo(contInfo) {
  const result = [];
  if (!contInfo) return result;
  const segments = contInfo.split(/,\s*(?=[가-힣])/);
  for (const seg of segments) {
    const numMatch = seg.match(/:\s*(\d+(?:\.\d+)?)\s*%/);
    if (!numMatch) continue;
    let category = null;
    for (const [pattern, cat] of HAZARD_PARSE_KW) {
      if (pattern.test(seg)) { category = cat; break; }
    }
    if (!category) continue;
    result.push({
      category,
      threshold: parseFloat(numMatch[1]),
      operator: parseOperator(seg),
    });
  }
  return result;
}

// 사고대비물질 contInfo("톨루엔 및 이를 85% 이상 함유한 혼합물") → { threshold: 85, operator: '>=' }
function parseAccidentThreshold(contInfo) {
  if (!contInfo) return null;
  const m = contInfo.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  return { threshold: parseFloat(m[1]), operator: parseOperator(contInfo) };
}

function criterionText(threshold, operator) {
  if (threshold == null) return null;
  return `${OPERATOR_SYMBOL[operator] || '≥'}${threshold}%`;
}

/** typeList 원본 행 하나를 상세 팝업용 소스 레코드로 변환 */
function buildSourceRecord(t, itemName) {
  return {
    itemName: itemName || '',
    subType: (t.sbstnClsfTypeNm || '').trim(),
    uniqueNo: (t.unqNo || '').trim() || null,
    contInfo: (t.contInfo || '').trim(),
    excpInfo: (t.excpInfo || '').trim(),
    ancmntYmd: (t.ancmntYmd || '').trim(),
    ancmntInfo: (t.ancmntInfo || '').trim(),
  };
}

function emptyResult(cas) {
  return {
    success: true,
    casNo: cas,
    notFound: true,
    chemicalName: '',
    chemicalNameKor: '',
    chemicalNameEn: '',
    existingChemical: { matched: false, korexst: '', keNo: '', sources: [] },
    prohibited: false,
    prohibitedReason: '',
    prohibitedUniqueNo: null,
    prohibitedSources: [],
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

  const res = await fetchWithRetry(`${KREACH_URL}?${params.toString()}`, {}, { api: 'kreach', cas });
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

  // 검색된 CAS와 일치하는 item을 전부 사용한다(입자크기 등으로 item이 여러 개
  // 나뉘어 있을 수 있음). casNo 필드가 없는 응답 형태에도 대응하도록, 일치하는
  // 것이 하나도 없으면 전체 item을 그대로 사용한다.
  const matchingItems = items.filter((it) => !it.casNo || (it.casNo || '').trim() === cas);
  const usableItems = matchingItems.length ? matchingItems : items;

  const primaryItem = usableItems[0];
  const nameKor = (primaryItem.sbstnNmKor || '').trim();
  const nameEn = (primaryItem.sbstnNmEng || '').trim();

  // 기존화학물질 번호는 반드시 화학물질 기본정보의 korexst 값만 사용한다.
  // typeList[].unqNo, 등록대상기존화학물질의 unqNo, sbstnId, 배열 인덱스 등
  // 다른 값으로 대체하지 않는다 — item들 중 첫 번째로 확인되는 korexst를 쓴다.
  let existingNo = '';
  for (const it of usableItems) {
    if (typeof it.korexst === 'string' && it.korexst.trim()) { existingNo = it.korexst.trim(); break; }
  }

  // 모든 item의 typeList를 하나로 합친다(item 구분명은 소스 기록에 남긴다)
  const typeList = [];
  usableItems.forEach((it) => {
    const raw = it.typeList || [];
    const list = Array.isArray(raw) ? raw : [raw];
    const itemName = (it.sbstnNmKor || it.sbstnNmEng || '').trim();
    list.forEach((t) => typeList.push({ t, itemName }));
  });

  const result = {
    success: true,
    casNo: cas,
    notFound: false,
    chemicalName: nameKor || nameEn || '',
    chemicalNameKor: nameKor,
    chemicalNameEn: nameEn,
    existingChemical: { matched: false, korexst: existingNo, keNo: existingNo, sources: [] },
    prohibited: false,
    prohibitedReason: '',
    prohibitedUniqueNo: null,
    prohibitedSources: [],
    regulations: [],
    infoTags: [],
  };

  let existingChemMatched = false;

  // 인체등유해성물질: 같은 (구분, 고유번호) 조합의 기준값 중 최소값만 채택하되
  // 기여한 원본 행은 모두 sources[]에 남긴다.
  const hazardGroups = new Map(); // key: `${category}|${uniqueNo}` -> {category, threshold, operator, uniqueNo, sources}
  // 유독/허가/제한물질, 사고대비물질도 (유형, 고유번호) 조합으로 중복 제거한다
  // (동일 규제가 typeList에 여러 행으로, 혹은 여러 item에 걸쳐 중복 등록될 수 있음)
  const simpleRegGroups = new Map(); // key: `${label}|${uniqueNo}` -> {sources}
  const accidentGroups = new Map();  // key: `${threshold}|${uniqueNo}` -> {threshold, operator, uniqueNo, sources}
  const infoTagGroups = new Map();   // key: type -> {type, sources}

  for (const { t, itemName } of typeList) {
    const nm = t.sbstnClsfTypeNm || '';
    const cont = (t.contInfo || '').trim();
    const unq = (t.unqNo || '').trim();
    const src = buildSourceRecord(t, itemName);

    if (nm.includes('인체등유해성물질')) {
      parseHazardContInfo(cont).forEach(({ category, threshold, operator }) => {
        const key = category + '|' + (unq || '');
        const existing = hazardGroups.get(key);
        if (!existing) {
          hazardGroups.set(key, { category, threshold, operator, uniqueNo: unq || null, sources: [src] });
        } else {
          existing.sources.push(src);
          if (threshold < existing.threshold) {
            existing.threshold = threshold;
            existing.operator = operator;
          }
        }
      });
      continue;
    }

    // "등록대상기존화학물질"에도 "기존화학물질"이 포함되므로 반드시
    // 일반 기존화학물질보다 먼저 분리한다. 그렇지 않으면 등록대상 번호
    // (예: 306)가 기존화학물질 KE 번호처럼 표시될 수 있다.
    if (nm.includes('등록대상기존화학물질') || nm.includes('등록대상')) {
      const key = '등록대상기존화학물질';
      const existing = infoTagGroups.get(key);
      if (!existing) infoTagGroups.set(key, { type: key, sources: [src] });
      else existing.sources.push(src);
      continue;
    }

    if (nm.includes('기존화학물질')) {
      existingChemMatched = true;
      result.existingChemical.sources.push(src);
      continue;
    }

    if (nm.includes('금지물질')) {
      result.prohibited = true;
      if (!result.prohibitedReason) result.prohibitedReason = t.excpInfo ? t.excpInfo.trim() : '금지물질';
      if (!result.prohibitedUniqueNo) result.prohibitedUniqueNo = unq || null;
      result.prohibitedSources.push(src);
      continue;
    }

    if (nm.includes('사고대비물질')) {
      const parsedAcc = parseAccidentThreshold(cont);
      const threshold = parsedAcc ? parsedAcc.threshold : null;
      const operator = parsedAcc ? parsedAcc.operator : '>=';
      const key = `${threshold}|${unq || ''}`;
      const existing = accidentGroups.get(key);
      if (!existing) {
        accidentGroups.set(key, { threshold, operator, uniqueNo: unq || null, sources: [src] });
      } else {
        existing.sources.push(src);
      }
      continue;
    }

    if (nm.includes('유독물질') || nm.includes('허가물질') || nm.includes('제한물질')) {
      const label = nm.includes('유독물질') ? '유독물질' : nm.includes('허가물질') ? '허가물질' : '제한물질';
      const key = `${label}|${unq || ''}`;
      const existing = simpleRegGroups.get(key);
      if (!existing) {
        simpleRegGroups.set(key, { type: label, uniqueNo: unq || null, sources: [src] });
      } else {
        existing.sources.push(src);
      }
      continue;
    }

    if (nm.includes('중점관리물질')) {
      const key = '중점관리물질';
      const existing = infoTagGroups.get(key);
      if (!existing) infoTagGroups.set(key, { type: key, sources: [src] });
      else existing.sources.push(src);
      continue;
    }
    // 그 외(로테르담협약물질 등)는 구매판정과 무관하므로 무시
  }

  result.existingChemical.matched = existingChemMatched;

  hazardGroups.forEach(({ category, threshold, operator, uniqueNo, sources }) => {
    result.regulations.push({
      type: '인체등유해성물질',
      hazardCategory: category,
      thresholdValue: threshold,
      operator,
      criterion: criterionText(threshold, operator),
      uniqueNo,
      sources,
    });
  });

  simpleRegGroups.forEach(({ type, uniqueNo, sources }) => {
    result.regulations.push({
      type,
      hazardCategory: null,
      thresholdValue: null, // 함량 무관 — 해당 시 항상 규제대상
      operator: null,
      criterion: null,
      uniqueNo,
      sources,
    });
  });

  accidentGroups.forEach(({ threshold, operator, uniqueNo, sources }) => {
    result.regulations.push({
      type: '사고대비물질',
      hazardCategory: null,
      thresholdValue: threshold,
      operator,
      criterion: criterionText(threshold, operator),
      uniqueNo,
      sources,
    });
  });

  infoTagGroups.forEach(({ type, sources }) => {
    result.infoTags.push({ type, sources });
  });

  return result;
}

/**
 * 기준값이 없으면(함량 무관 규제) 항상 해당.
 * 연산자별 비교:
 *   >=  : 사용자가 이하(포함) 선택 시 max>=thr, 미만(제외) 선택 시 max>thr
 *   >   : max>thr (사용자의 이하/미만 선택과 무관 — 경계값에서 자연히 같은 결과)
 *   <=  : max<=thr (드문 케이스, 최댓값 기준 보수적 비교)
 *   <   : max<thr
 */
function isThresholdExceeded(reg, contentMax, isLt) {
  if (reg.thresholdValue == null) return true;
  if (contentMax == null) return false;
  const thr = reg.thresholdValue;
  switch (reg.operator) {
    case '>':  return contentMax > thr;
    case '<=': return contentMax <= thr;
    case '<':  return contentMax < thr;
    case '>=':
    default:
      return isLt ? contentMax > thr : contentMax >= thr;
  }
}

/**
 * 캐시된 raw 결과 위에서 함량 판정(matchedByContent)만 계산하는 순수 함수.
 * 업스트림 호출이 없으므로 캐시하지 않고 매 요청마다 실행한다.
 */
function applyContentJudgment(raw, contentMax, isLt) {
  if (!raw || raw.success !== true) return raw;
  const regulations = (raw.regulations || []).map((r) => ({
    ...r,
    matchedByContent: isThresholdExceeded(r, contentMax, !!isLt),
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
  parseAccidentThreshold,
};
