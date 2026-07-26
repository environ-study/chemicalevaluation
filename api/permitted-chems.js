/* ============================================================
   api/permitted-chems.js — 전사 공유 사내 허가 유해화학물질 목록
   ─────────────────────────────────────────────────────────
   저장 키: CAS 번호 + 유해화학물질 고유번호 (기존화학물질 KE번호는
   허가 대조 대상이 아니므로 등록 자체를 거부한다).

   GET  → 전체 목록 조회
   POST { mode: 'append'|'replace'|'delete', items:[{casNo,uniqueNo}] }
        → append: 기존 목록에 추가(중복 제외)
        → replace: 전체 교체
        → delete: 지정 항목 삭제
   ============================================================ */

const { kv } = require('@vercel/kv');
const {
  normalizeCas,
  isValidCasFormat,
  normalizeUniqueNo,
  isKeNumber,
  compositeKey,
} = require('./_lib/normalize');

const LIST_KEY = 'permitted_chems:list';

async function loadList() {
  try {
    const list = await kv.get(LIST_KEY);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    const err = new Error('사내 허가목록 저장소에 연결할 수 없습니다.');
    err.storageError = true;
    throw err;
  }
}

async function saveList(list) {
  try {
    await kv.set(LIST_KEY, list);
  } catch (e) {
    const err = new Error('사내 허가목록 저장에 실패했습니다.');
    err.storageError = true;
    throw err;
  }
}

/** CAS/고유번호 정규화 + 검증. 빈 행은 조용히 무시, 형식 오류는 사유와 함께 반환 */
function validateRows(rawItems) {
  const valid = [];
  const errors = [];
  const seen = new Set();

  (Array.isArray(rawItems) ? rawItems : []).forEach((raw, idx) => {
    const rowNo = idx + 1;
    const casNo = normalizeCas(raw && raw.casNo);
    const uniqueNo = normalizeUniqueNo(raw && raw.uniqueNo);

    if (!casNo && !uniqueNo) return; // 빈 행

    if (!casNo) {
      errors.push({ row: rowNo, reason: 'CAS 번호가 없습니다(고유번호만 입력된 행은 저장할 수 없습니다).' });
      return;
    }
    if (!isValidCasFormat(casNo)) {
      errors.push({ row: rowNo, reason: `CAS 번호 형식이 올바르지 않습니다: ${casNo}` });
      return;
    }
    if (!uniqueNo) {
      errors.push({ row: rowNo, reason: 'CAS만 입력되고 유해화학물질 고유번호가 없습니다.' });
      return;
    }
    if (isKeNumber(uniqueNo)) {
      errors.push({
        row: rowNo,
        reason: '기존화학물질(KE) 번호는 유해화학물질 고유번호가 아니므로 등록할 수 없습니다.',
      });
      return;
    }

    const key = compositeKey(casNo, uniqueNo);
    if (seen.has(key)) return; // 동일 조합 중복 — 조용히 제거
    seen.add(key);
    valid.push({ casNo, uniqueNo });
  });

  return { valid, errors };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const items = await loadList();
      res.status(200).json({ success: true, items, count: items.length });
    } catch (err) {
      res.status(503).json({
        success: false,
        retryable: true,
        errorCode: 'STORAGE_UNAVAILABLE',
        message: err.message,
      });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({
      success: false,
      retryable: false,
      errorCode: 'METHOD_NOT_ALLOWED',
      message: 'GET 또는 POST만 지원합니다.',
    });
    return;
  }

  const body = req.body || {};
  const mode = body.mode === 'replace' || body.mode === 'delete' ? body.mode : 'append';
  const { valid, errors } = validateRows(body.items);

  if (mode !== 'delete' && !valid.length && errors.length) {
    res.status(400).json({
      success: false,
      retryable: false,
      errorCode: 'VALIDATION_FAILED',
      message: '유효한 항목이 없습니다.',
      errors,
    });
    return;
  }

  try {
    const existing = await loadList();
    let finalList;

    if (mode === 'replace') {
      finalList = valid;
    } else if (mode === 'delete') {
      const deleteKeys = new Set(
        (Array.isArray(body.items) ? body.items : []).map((it) =>
          compositeKey(it && it.casNo, it && it.uniqueNo)
        )
      );
      finalList = existing.filter((it) => !deleteKeys.has(compositeKey(it.casNo, it.uniqueNo)));
    } else {
      const existingKeys = new Set(existing.map((it) => compositeKey(it.casNo, it.uniqueNo)));
      finalList = existing.slice();
      valid.forEach((it) => {
        const key = compositeKey(it.casNo, it.uniqueNo);
        if (!existingKeys.has(key)) {
          existingKeys.add(key);
          finalList.push(it);
        }
      });
    }

    await saveList(finalList);
    res.status(200).json({
      success: true,
      items: finalList,
      count: finalList.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      retryable: true,
      errorCode: 'STORAGE_UNAVAILABLE',
      message: err.message,
    });
  }
};
