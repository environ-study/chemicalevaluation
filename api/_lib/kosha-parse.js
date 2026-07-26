/* ============================================================
   api/_lib/kosha-parse.js — 산안법 KOSHA 원문 조회 + 규제 판정
   ─────────────────────────────────────────────────────────
   BACK/api_kosha.py(구 Flask 백엔드)의 2단계 조회(getChemList →
   getChemDetail15) 및 XML/JSON 이중 응답 처리를 그대로 이식한다.
   브라우저 DOMParser 없이 Node 환경에서 동작하도록 fast-xml-parser 사용.

   itemDetail은 구조화되지 않은 법령 텍스트 블롭이므로(업스트림 자체 한계),
   기존과 동일하게 키워드 매칭으로 규제유형을 판별한다. 실제 응답 문구가
   다를 경우 CATEGORY_KEYWORDS 튜닝이 필요할 수 있다.
   ============================================================ */

const { XMLParser } = require('fast-xml-parser');
const { fetchWithRetry } = require('./http');

const KOSHA_URL = 'https://apis.data.go.kr/B552468/msdschem';

const xmlParser = new XMLParser({ ignoreAttributes: true, trimValues: true });

function parseResponseItems(text, contentType) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || (contentType || '').toLowerCase().includes('json')) {
    const data = JSON.parse(trimmed);
    let items =
      (data.response && data.response.body && data.response.body.items) ||
      (data.body && data.body.items) ||
      [];
    if (items && items.item !== undefined) items = items.item;
    if (items && !Array.isArray(items)) items = [items];
    return items || [];
  }

  // XML (공공데이터포털 응답에는 <script/> 자기종결 태그가 섞여 있을 수 있으나
  // 유효한 XML이므로 표준 파서로 문제없이 처리된다)
  const parsed = xmlParser.parse(trimmed);
  const body = (parsed.response && parsed.response.body) || parsed.body || {};
  let items = body.items;
  if (items && items.item !== undefined) items = items.item;
  if (items && !Array.isArray(items)) items = [items];
  if (!items) return [];

  return items.map((it) => {
    const out = {};
    Object.keys(it || {}).forEach((k) => {
      out[k] = it[k] == null ? '' : String(it[k]).trim();
    });
    return out;
  });
}

async function getItems(endpoint, params, apiKey, cas) {
  const qs = new URLSearchParams({ serviceKey: apiKey, ...params });
  const res = await fetchWithRetry(`${KOSHA_URL}${endpoint}?${qs.toString()}`, {}, { api: 'kosha', cas });
  if (!res.ok) {
    const err = new Error(`KOSHA upstream HTTP ${res.status}`);
    err.upstreamRes = res;
    throw err;
  }
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  try {
    return parseResponseItems(text, contentType);
  } catch (e) {
    const err = new Error('KOSHA 응답 파싱 실패');
    err.upstreamParseError = true;
    throw err;
  }
}

// 참고: "제조등금지물질"/"특별관리물질"은 기존 백엔드에서 실제 응답으로 검증된 키워드.
// "허가대상 유해물질"/"관리대상 유해물질"은 스펙 요구로 추가한 것으로, 실제
// getChemDetail15 문구와 다를 경우 재검증·튜닝이 필요하다.
const CATEGORY_KEYWORDS = [
  { type: '제조 등의 금지물질', keywords: ['제조등금지물질', '제조·사용금지', '제조 등 금지'] },
  { type: '허가대상 유해물질', keywords: ['허가대상유해물질', '허가대상 유해물질'] },
  { type: '특별관리물질', keywords: ['특별관리물질'] },
  { type: '관리대상 유해물질', keywords: ['관리대상유해물질', '관리대상 유해물질'] },
];

function emptyResult(cas) {
  return {
    success: true,
    casNo: cas,
    notFound: true,
    chemId: '',
    chemicalName: '',
    regulations: [],
    prohibited: false,
    specialManagement: false,
  };
}

async function fetchKoshaResult(casNo, apiKey) {
  const cas = (casNo || '').trim();
  if (!cas) return emptyResult(cas);

  const listItems = await getItems(
    '/getChemList',
    { searchWrd: cas, searchCnd: '1', numOfRows: '10', pageNo: '1' },
    apiKey,
    cas
  );

  if (!listItems.length) return emptyResult(cas);

  const exact = listItems.find((i) => (i.casNo || '').trim() === cas);
  const item0 = exact || listItems[0];
  const chemId = (item0.chemId || '').trim();
  const chemName = (item0.chemNameKor || '').trim();

  if (!chemId) return emptyResult(cas);

  const chemIdPadded = chemId.padStart(6, '0');

  const result = {
    success: true,
    casNo: cas,
    notFound: false,
    chemId: chemIdPadded,
    chemicalName: chemName,
    regulations: [],
    prohibited: false,
    specialManagement: false,
  };

  // 15절(법적 규제현황) 조회 실패는 "규제없음"이 아니라 실제 오류로 취급해
  // 잘못된 비규제 판정이 캐시/노출되지 않도록 한다 — 호출부에서 재시도 유도.
  const detailItems = await getItems('/getChemDetail15', { chemId: chemIdPadded }, apiKey, cas);

  const fullText = detailItems.map((it) => it.itemDetail || '').join(' | ');

  CATEGORY_KEYWORDS.forEach(({ type, keywords }) => {
    if (keywords.some((kw) => fullText.includes(kw))) {
      result.regulations.push({ type, matched: true });
    }
  });

  result.prohibited = result.regulations.some((r) => r.type === '제조 등의 금지물질');
  result.specialManagement = result.regulations.some((r) => r.type === '특별관리물질');

  return result;
}

module.exports = { KOSHA_URL, fetchKoshaResult, parseResponseItems };
