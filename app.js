/* ============================================================
   app.js — MSDS 직접입력 분석 포털 (로직 전담)

   [구조 개요]
   1. 상수/전역 상태
   2. 사내 허가목록 로드 + 서버 상태 표시
   3. MSDS 시트 관리 (addMsdsSheet / removeMsdsSheet)
   4. 직접입력 행 관리 (addManualRow)
   5. 키보드 탐색 (화살표키 / Tab / Enter)
   6. 붙여넣기 파싱 (parseFlexibleLine 등)
   7. CAS 번호 자동 포맷 (formatCAS / onCASInput)
   8. 분석 실행 (doManual → /api/kreach·/api/kosha 병렬 조회)
   9. 4단계 구매 판정 (decidePurchase)
   10. 결과 렌더링 (renderAll + 셀 빌더)
   11. 사내 허가목록 관리 모달
   12. LOC(Word) 확인서 자동 생성
   13. 에러 표시 / 유틸
   ============================================================ */

/* shared/normalize.js(UMD)가 app.js보다 먼저 로드되어 있어야 한다 */
const { normalizeCas, isValidCasFormat, normalizeUniqueNo, isKeNumber, compositeKey } = window.ChemNormalize;

/* ═══════════════════════════════════════════════════════════
   1. 상수 / 전역 상태
   ═══════════════════════════════════════════════════════════ */
let sheetId = 0;   // MSDS 시트 순번
let rowId   = 0;   // 입력 행 순번
let lastResultData = null;  // 마지막 분석 결과(시트 배열) — 복사/LOC 생성용

// 사내 허가 화학물질 목록 전역 상태
let permittedItems = [];          // [{casNo, uniqueNo}, ...]
let permittedSet = new Set();     // "cas|uniqueNo" 복합키 Set
let permittedUnavailable = false; // 목록 로드 실패 여부(분석은 계속 가능)

// CAS 검색 히스토리 (localStorage 기반)
const CAS_HISTORY_KEY = 'cas_history';

function getCasHistory() {
  try { return JSON.parse(localStorage.getItem(CAS_HISTORY_KEY) || '{}'); }
  catch { return {}; }
}

function recordCas(cas) {
  if (!cas || cas.length < 5) return;
  const h = getCasHistory();
  if (!h[cas]) h[cas] = { count: 0, lastUsed: 0 };
  h[cas].count += 1;
  h[cas].lastUsed = Date.now();
  localStorage.setItem(CAS_HISTORY_KEY, JSON.stringify(h));
}

function getFrequentCas(minCount = 4) {
  const h = getCasHistory();
  return Object.entries(h)
    .filter(([, data]) => data.count >= minCount)
    .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    .slice(0, 5)
    .map(([cas]) => [cas, h[cas].count]);
}

/* ═══════════════════════════════════════════════════════════
   2. 사내 허가목록 로드 + 서버 상태 표시
   ─────────────────────────────────────────────────────────
   별도 헬스체크 엔드포인트 대신, 페이지 로드시 어차피 필요한
   GET /api/permitted-chems 호출 성공 여부로 서버 상태를 표시한다.
   목록 로드에 실패해도 분석 자체는 계속 진행 가능하며, 이 경우
   허가 여부 판정은 "검토 필요(확인 불가)"로 처리된다.
   ═══════════════════════════════════════════════════════════ */
async function loadPermittedListAndStatus() {
  const txt = document.getElementById('srvTxt');
  const bar = document.getElementById('srvBar');
  if (txt) txt.textContent = '사내 허가목록 확인 중...';

  try {
    const r = await fetch('/api/permitted-chems', { signal: AbortSignal.timeout(15000) });
    const d = await r.json();
    if (!d.success) throw new Error(d.message || '허가목록 조회 실패');

    permittedItems = d.items || [];
    permittedSet = new Set(permittedItems.map((it) => compositeKey(it.casNo, it.uniqueNo)));
    permittedUnavailable = false;

    if (txt) txt.textContent = `✅ 서버 정상 — 사내 허가목록 ${permittedItems.length}건 로드됨`;
    if (bar) bar.style.color = 'var(--green)';
  } catch (e) {
    permittedUnavailable = true;
    permittedItems = [];
    permittedSet = new Set();
    if (txt) txt.textContent = '⚠️ 사내 허가목록을 불러오지 못했습니다 (분석은 계속 가능 / 허가 여부는 검토필요로 표시)';
    if (bar) bar.style.color = 'var(--orange)';
  }

  renderPermittedTable();
}


/* ═══════════════════════════════════════════════════════════
   3. MSDS 시트 관리
   ═══════════════════════════════════════════════════════════ */
function addMsdsSheet(name) {
  sheetId++;
  const sid = sheetId;
  const container = document.getElementById('msdsSheets');

  const sheet = document.createElement('div');
  sheet.className = 'msds-sheet';
  sheet.id = 'sheet-' + sid;

  const head = document.createElement('div');
  head.className = 'msds-sheet-head';
  head.innerHTML = `
    <input type="text" placeholder="MSDS 제품명 (예: 톨루엔 MSDS)" value="${escHtml(name)}">
    <button class="msds-rm-btn" onclick="removeMsdsSheet(${sid})">✕ 시트 삭제</button>
  `;

  const body = document.createElement('div');
  body.className = 'msds-sheet-body';
  body.id = 'sheet-body-' + sid;
  body.innerHTML = `
    <div class="cas-history-bar" id="cas-hist-${sid}"></div>
    <div class="manual-header">
      <span>#</span>
      <span>CAS번호</span>
      <span>최소(%)</span>
      <span>최대(%)</span>
      <span title="이하=최대값 포함(≤) / 미만=최대값 미포함(<)">이하/미만</span>
      <span></span>
    </div>
    <div id="rows-${sid}"></div>
    <button class="msds-add-row" onclick="addManualRow(${sid},'',null,null,false)">+ 행 추가</button>
  `;

  sheet.appendChild(head);
  sheet.appendChild(body);
  container.appendChild(sheet);
  renderCasHistoryBar(sid);
  addManualRow(sid, '', null, null, false);
}

function removeMsdsSheet(sid) {
  const el = document.getElementById('sheet-' + sid);
  if (el) el.remove();
}

function renumberSheet(sid) {
  const rowsDiv = document.getElementById('rows-' + sid);
  if (!rowsDiv) return;
  [...rowsDiv.querySelectorAll('.manual-row')].forEach((row, i) => {
    const el = row.querySelector('.row-num');
    if (el) el.textContent = i + 1;
  });
}


/* ═══════════════════════════════════════════════════════════
   4. 직접입력 행 관리
   ═══════════════════════════════════════════════════════════ */
function addManualRow(sid, cas, min, max, isLt) {
  const id = ++rowId;
  const container = document.getElementById('rows-' + sid);
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'manual-row';
  row.id = 'mrow-' + id;
  row.dataset.sheet = sid;

  const numSpan = document.createElement('span');
  numSpan.className = 'row-num';
  numSpan.textContent = '·';

  const casInput = document.createElement('input');
  casInput.type = 'text';
  casInput.placeholder = '예: 108-88-3';
  casInput.value = String(cas || '');
  casInput.id = 'cas-' + id;
  casInput.maxLength = 12;
  casInput.setAttribute('oninput', 'onCASInput(this)');
  casInput.setAttribute('autocomplete', 'off');

  const minInput = document.createElement('input');
  minInput.type = 'number';
  minInput.placeholder = '0';
  minInput.min = '0'; minInput.max = '100'; minInput.step = '0.01';
  minInput.value = (min !== null && min !== '') ? min : '';
  minInput.id = 'min-' + id;

  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.placeholder = '100';
  maxInput.min = '0'; maxInput.max = '100'; maxInput.step = '0.01';
  maxInput.value = (max !== null && max !== '') ? max : '';
  maxInput.id = 'max-' + id;

  const label = document.createElement('label');
  label.className = 'lt-label';
  label.title = '체크 = 미만(< 최대값 미포함) / 미체크 = 이하(≤ 최대값 포함)';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'lt-' + id;
  cb.checked = !!isLt;

  const ltTxt = document.createElement('span');
  ltTxt.id = 'lt-txt-' + id;
  ltTxt.style.color = isLt ? 'var(--orange)' : 'var(--muted)';
  ltTxt.textContent = isLt ? '미만 < (미포함)' : '이하 ≤ (포함)';

  cb.addEventListener('change', function () {
    ltTxt.style.color = cb.checked ? 'var(--orange)' : 'var(--muted)';
    ltTxt.textContent = cb.checked ? '미만 < (미포함)' : '이하 ≤ (포함)';
  });
  label.appendChild(cb);
  label.appendChild(ltTxt);

  const rmBtn = document.createElement('button');
  rmBtn.className = 'rm-btn';
  rmBtn.title = '삭제';
  rmBtn.textContent = '✕';
  rmBtn.addEventListener('click', function () { row.remove(); renumberSheet(sid); });

  row.appendChild(numSpan);
  row.appendChild(casInput);
  row.appendChild(minInput);
  row.appendChild(maxInput);
  row.appendChild(label);
  row.appendChild(rmBtn);
  container.appendChild(row);
  renumberSheet(sid);
}


/* ═══════════════════════════════════════════════════════════
   5. 키보드 탐색
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', function (e) {
  const el = e.target;
  if (!el.closest('.manual-row')) return;
  if (!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Enter','Tab'].includes(e.key)) return;

  const row = el.closest('.manual-row');
  const rowsDiv = row.parentElement;
  let allRows = [...rowsDiv.querySelectorAll('.manual-row')];
  const allInputs = [...row.querySelectorAll('input')];
  const navInputs = allInputs.filter(input => input.type !== 'checkbox');
  const colIdx = navInputs.indexOf(el);
  const rowIdx = allRows.indexOf(row);

  if (el.type === 'checkbox') return;

  if (e.key === 'Tab' || e.key === 'Enter') {
    e.preventDefault();
    const next = navInputs[colIdx + 1];
    if (next) {
      next.focus();
      if (next.select) next.select();
      return;
    }
    let nextRow = allRows[rowIdx + 1];
    if (!nextRow) {
      const sid = parseInt(row.dataset.sheet, 10);
      if (!sid) return;
      addManualRow(sid, '', null, null, false);
      allRows = [...rowsDiv.querySelectorAll('.manual-row')];
      nextRow = allRows[rowIdx + 1];
    }
    if (nextRow) {
      const firstInput = [...nextRow.querySelectorAll('input')]
        .find(input => input.type !== 'checkbox');
      if (firstInput) {
        firstInput.focus();
        if (firstInput.select) firstInput.select();
      }
    }
    return;
  }

  if (e.key === 'ArrowRight') {
    const atEnd = el.type === 'number' ? true : el.selectionStart === el.value.length;
    if (!atEnd) return;
    const next = navInputs[colIdx + 1];
    if (next) {
      e.preventDefault();
      next.focus();
      if (next.select) next.select();
    }
    return;
  }

  if (e.key === 'ArrowLeft') {
    const atStart = el.type === 'number' ? true : el.selectionStart === 0;
    if (!atStart) return;
    const prev = navInputs[colIdx - 1];
    if (prev) {
      e.preventDefault();
      prev.focus();
      if (prev.type === 'text') {
        const len = prev.value.length;
        prev.setSelectionRange(len, len);
      }
    }
    return;
  }

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const targetRow = allRows[rowIdx + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!targetRow) return;
    const targetNavInputs = [...targetRow.querySelectorAll('input')]
      .filter(input => input.type !== 'checkbox');
    const targetEl = targetNavInputs[colIdx] || targetNavInputs[0];
    if (targetEl) {
      targetEl.focus();
      if (targetEl.select) targetEl.select();
    }
  }
});

function renderCasHistoryBar(sid) {
  const bar = document.getElementById('cas-hist-' + sid);
  if (!bar) return;
  const freq = getFrequentCas(3);
  if (!freq.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '<span class="cas-hist-label">자주 쓴 CAS</span>' +
    freq.map(([c, cnt]) =>
      `<button class="cas-hist-btn" onclick="addManualRow(${sid},'${c}',null,null,false);renderCasHistoryBar(${sid})" title="${cnt}회 검색">
        ${c}
      </button>`
    ).join('');
}

function refreshAllHistoryBars() {
  document.querySelectorAll('[id^="cas-hist-"]').forEach(el => {
    const sid = el.id.replace('cas-hist-', '');
    renderCasHistoryBar(parseInt(sid));
  });
}

document.addEventListener('keydown', function(e) {
  if (e.key !== '+') return;
  const el = document.activeElement;
  const row = el?.closest('.manual-row');
  if (!row) return;
  e.preventDefault();
  const sid = row.dataset.sheet;
  if (sid) addManualRow(parseInt(sid), '', null, null, false);
});

document.addEventListener('keydown', function(e) {
  if (e.key !== '-') return;
  const el = document.activeElement;
  const row = el?.closest('.manual-row');
  if (!row) return;
  e.preventDefault();
  const sid = row.dataset.sheet;
  if (!sid) return;
  const rowsDiv = document.getElementById('rows-' + sid);
  if (!rowsDiv) return;
  const allRows = [...rowsDiv.querySelectorAll('.manual-row')];
  for (let i = allRows.length - 1; i >= 0; i--) {
    const targetRow = allRows[i];
    const id = targetRow.id?.replace('mrow-', '');
    const casVal = document.getElementById('cas-' + id)?.value.trim();
    if (!casVal) {
      const isFocusedRow = targetRow === row;
      if (isFocusedRow) {
        const prevRow = allRows[i - 1];
        if (prevRow) {
          const prevInput = [...prevRow.querySelectorAll('input')]
            .find(input => input.type !== 'checkbox');
          if (prevInput) {
            prevInput.focus();
            if (prevInput.select) prevInput.select();
          }
        }
        targetRow.remove();
        break;
      }
    }
  }
});


/* ═══════════════════════════════════════════════════════════
   6. 붙여넣기 파싱
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('paste', function (e) {
  const el = e.target;
  const row = el.closest('.manual-row');
  if (!row) return;

  const text = e.clipboardData.getData('text/plain').trim();
  if (!text) return;

  const looksLikeTable =
    text.includes('\n') || text.includes('\t') || text.includes(',') || /\s{2,}/.test(text);

  if (!looksLikeTable) return;

  e.preventDefault();

  const sid = parseInt(row.dataset.sheet, 10);
  const rowsDiv = document.getElementById('rows-' + sid);
  if (!rowsDiv) return;

  const allRows = [...rowsDiv.querySelectorAll('.manual-row')];
  const startRowIdx = allRows.indexOf(row);

  const currentInputs = [...row.querySelectorAll('input')];
  const startColIdx = currentInputs.indexOf(el);

  const multiBlocks = parseVerticalMultiMsds(text);

  if (multiBlocks.length >= 2) {
    multiBlocks.forEach((block, idx) => {
      let targetSid;
      if (idx === 0) {
        targetSid = sid;
        const titleInput = document.querySelector(`#sheet-${targetSid} .msds-sheet-head input`);
        if (titleInput && !titleInput.value.trim() && block.title) {
          titleInput.value = block.title;
        }
        fillSheetRows(targetSid, block.rows, startRowIdx, startColIdx);
      } else {
        addMsdsSheet(block.title || '');
        targetSid = sheetId;
        fillSheetRows(targetSid, block.rows, 0, 0);
      }
    });
    return;
  }

  const parsed = parsePastedTable(text);
  const table = parsed.rows || [];
  if (!table.length) return;

  if (parsed.title) {
    const titleInput = document.querySelector(`#sheet-${sid} .msds-sheet-head input`);
    if (titleInput && !titleInput.value.trim()) {
      titleInput.value = parsed.title;
    }
  }

  fillSheetRows(sid, table, startRowIdx, startColIdx);
});

function parseVerticalMultiMsds(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (isTitleLine(line)) {
      if (current && current.rows.length) blocks.push(current);
      current = { title: line, rows: [] };
      continue;
    }
    const parsed = parseFlexibleLine(line);
    if (looksLikeParsedDataRow(parsed)) {
      if (!current) current = { title: '', rows: [] };
      current.rows.push(normalizeDataRow(parsed));
    }
  }

  if (current && current.rows.length) blocks.push(current);

  const titledCount = blocks.filter(b => (b.title || '').trim()).length;
  if (blocks.length >= 2 && titledCount >= 2) return blocks;
  return [];
}

function looksLikeParsedDataRow(parsed) {
  if (!Array.isArray(parsed) || parsed.length < 2) return false;
  const cas = parsed[0];
  const min = parsed[1];
  const max = parsed[2];
  if (!isCasLike(cas)) return false;
  if (!isNumericLike(min)) return false;
  if (max != null && max !== '' && !isNumericLike(max)) return false;
  return true;
}

// 4번째 열(이하/미만 플래그) 텍스트를 판별
// y/Y/미만/</true -> 미만(체크) / n/N/이하/<=/false/빈값 -> 이하(미체크)
function parseLtFlag(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'y' || v === '미만' || v === '<' || v === 'true') return true;
  return false;
}

function normalizeDataRow(parsed) {
  const row = [...parsed];
  const cas = row[0] ?? '';
  const min = row[1] ?? '';
  const max = row[2] ?? '';
  const flag = row[3] ?? '';
  return [cas, min, max, flag];
}

function fillSheetRows(sid, rows, startRowIdx = 0, startColIdx = 0) {
  const rowsDiv = document.getElementById('rows-' + sid);
  if (!rowsDiv) return;

  const neededRows = startRowIdx + rows.length;
  while (rowsDiv.querySelectorAll('.manual-row').length < neededRows) {
    addManualRow(sid, '', null, null, false);
  }

  const updatedRows = [...rowsDiv.querySelectorAll('.manual-row')];

  rows.forEach((cols, rIdx) => {
    const targetRow = updatedRows[startRowIdx + rIdx];
    if (!targetRow) return;
    const inputs = [...targetRow.querySelectorAll('input')];

    cols.forEach((rawValue, cIdx) => {
      const colIdx = startColIdx + cIdx;
      const input = inputs[colIdx];
      if (!input) return;
      const value = (rawValue || '').trim();

      if (input.type === 'checkbox') {
        input.checked = parseLtFlag(value);
        input.dispatchEvent(new Event('change'));
        return;
      }
      if (input.type === 'number') {
        input.value = value.replace(/[^\d.\-]/g, '');
        return;
      }
      input.value = value;
      if (input.id.startsWith('cas-')) onCASInput(input);
    });
  });
}

function parsePastedTable(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (!lines.length) return { title: '', rows: [] };

  let title = '';
  let startIdx = 0;

  if (isTitleLine(lines[0])) {
    title = lines[0];
    startIdx = 1;
  }

  const rows = lines
    .slice(startIdx)
    .map(parseFlexibleLine)
    .filter(row => row.length > 0);

  return { title, rows };
}

function isTitleLine(line) {
  const s = (line || '').trim();
  if (!s) return false;
  if (s.includes('\t') || s.includes(',')) return false;
  if (looksLikeDataLine(s)) return false;
  if (/^[\d.\-\s]+$/.test(s)) return false;
  return /[A-Za-z가-힣]/.test(s);
}

function looksLikeDataLine(line) {
  const parsed = parseFlexibleLine(line);
  if (parsed.length < 2) return false;
  const casCandidate = parsed[0];
  const num1 = parsed[1];
  const num2 = parsed[2];
  const casOk = isCasLike(casCandidate);
  const n1Ok = isNumericLike(num1);
  const n2Ok = num2 == null ? true : isNumericLike(num2);
  return casOk && n1Ok && n2Ok;
}

function parseFlexibleLine(line) {
  const s = (line || '').trim();
  if (!s) return [];

  if (s.includes(',')) {
    return parseCsvLine(s).map(v => v.trim()).filter(Boolean);
  }

  if (s.includes('\t')) {
    const parts = s.split('\t').map(v => v.trim()).filter(Boolean);
    let expanded = [];
    for (const part of parts) {
      if (/\s{2,}/.test(part)) {
        expanded.push(...part.split(/\s{2,}/).map(v => v.trim()).filter(Boolean));
      } else {
        expanded.push(part);
      }
    }
    return normalizeRow(expanded);
  }

  let parts;
  if (/\s{2,}/.test(s)) {
    parts = s.split(/\s{2,}/).map(v => v.trim()).filter(Boolean);
  } else {
    parts = s.split(/\s+/).map(v => v.trim()).filter(Boolean);
  }
  return normalizeRow(parts);
}

function normalizeRow(parts) {
  if (!parts.length) return [];
  return [...parts];
}

function isCasLike(value) {
  const v = String(value || '').trim();
  const digits = v.replace(/\D/g, '');
  return digits.length >= 5 && digits.length <= 10;
}

function isNumericLike(value) {
  if (value == null) return false;
  return /^-?\d+(?:\.\d+)?$/.test(String(value).trim());
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  result.push(cur.trim());
  return result;
}


/* ═══════════════════════════════════════════════════════════
   7. CAS 번호 자동 하이픈 포맷
   ═══════════════════════════════════════════════════════════ */
function formatCAS(val) {
  const digits = val.replace(/\D/g, '');
  if (!digits) return '';
  const len = digits.length;
  if (len <= 2) return digits;
  if (len === 3) return digits.slice(0, 1) + '-' + digits.slice(1, 3);
  const check = digits.slice(-1);
  const mid   = digits.slice(-3, -1);
  const front = digits.slice(0, len - 3);
  return front + '-' + mid + '-' + check;
}

function onCASInput(el) {
  const pos       = el.selectionStart;
  const old       = el.value;
  const formatted = formatCAS(old);
  if (formatted !== old) {
    el.value = formatted;
    const diff = formatted.length - old.length;
    el.setSelectionRange(pos + diff, pos + diff);
  }
}


/* ═══════════════════════════════════════════════════════════
   8. 분석 실행
   ─────────────────────────────────────────────────────────
   /api/kreach, /api/kosha를 성분별로 직접(same-origin) 병렬 호출한다.
   6개씩 청크로 나눠 과도한 동시 요청을 피한다.
   ═══════════════════════════════════════════════════════════ */
async function fetchKreach(cas, contentMax, isLt) {
  const params = new URLSearchParams({ cas });
  if (contentMax != null) params.set('contentMax', String(contentMax));
  params.set('isLt', isLt ? 'true' : 'false');
  const r = await fetch('/api/kreach?' + params.toString(), { signal: AbortSignal.timeout(20000) });
  return r.json();
}

async function fetchKosha(cas) {
  const params = new URLSearchParams({ cas });
  const r = await fetch('/api/kosha?' + params.toString(), { signal: AbortSignal.timeout(20000) });
  return r.json();
}

async function doManual() {
  const sheets = [...document.getElementById('msdsSheets').children];
  if (!sheets.length) { alert('MSDS를 1개 이상 추가하세요.'); return; }

  const payload = [];
  const dedupeMap = new Map();

  for (const sheet of sheets) {
    const sid      = sheet.id.replace('sheet-', '');
    const nameEl   = sheet.querySelector('.msds-sheet-head input');
    const filename = (nameEl?.value || '').trim() || `MSDS ${sid}`;
    const rows     = [...(document.getElementById('rows-' + sid)?.children || [])];
    const comps    = [];

    for (const row of rows) {
      const id  = row.id?.replace('mrow-', '');
      if (!id) continue;
      const cas = document.getElementById('cas-' + id)?.value.trim();
      if (!cas) continue;
      const minRaw = document.getElementById('min-' + id)?.value;
      const maxRaw = document.getElementById('max-' + id)?.value;
      const minV   = minRaw !== '' ? parseFloat(minRaw) : null;
      const maxV   = maxRaw !== '' ? parseFloat(maxRaw) : null;
      const isLt   = document.getElementById('lt-' + id)?.checked || false;
      recordCas(cas);

      const dedupeKey = [filename, cas, minV ?? '', maxV ?? '', isLt ? 'lt' : 'incl'].join('|');
      if (dedupeMap.has(dedupeKey)) continue;
      dedupeMap.set(dedupeKey, true);

      comps.push({ cas, min: minV, max: maxV, isLt, kr: null, ko: null, verdict: null });
    }
    if (comps.length) payload.push({ filename, comps });
  }

  if (!payload.length) { alert('CAS번호를 1개 이상 입력하세요.'); return; }

  const totalComps = payload.reduce((s, r) => s + r.comps.length, 0);

  document.getElementById('runBtnM').disabled = true;
  const pw = document.getElementById('progWrapM');
  const pf = document.getElementById('progFillM');
  const pl = document.getElementById('progLabelM');
  pw.style.display = 'block';
  pf.style.width = '0%';

  const tasks = [];
  payload.forEach((sheet) => {
    sheet.comps.forEach((comp) => {
      tasks.push({ comp, type: 'kr' });
      tasks.push({ comp, type: 'ko' });
    });
  });

  let done = 0;
  const total = tasks.length;
  const updateProgress = () => {
    const pct = total ? Math.min(96, Math.round((done / total) * 96)) : 0;
    pf.style.width = pct + '%';
    pl.textContent = `K-REACH · KOSHA 조회 중... (${payload.length}개 MSDS / ${totalComps}종, ${done}/${total})`;
  };
  updateProgress();

  const CHUNK = 6;
  for (let i = 0; i < tasks.length; i += CHUNK) {
    const chunk = tasks.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async (task) => {
      try {
        if (task.type === 'kr') {
          task.comp.kr = await fetchKreach(task.comp.cas, task.comp.max, task.comp.isLt);
        } else {
          task.comp.ko = await fetchKosha(task.comp.cas);
        }
      } catch (e) {
        const errObj = {
          success: false,
          retryable: true,
          errorCode: 'CLIENT_FETCH_FAILED',
          message: e && e.message ? e.message : '조회 중 오류가 발생했습니다.',
        };
        if (task.type === 'kr') task.comp.kr = errObj; else task.comp.ko = errObj;
      }
      done++;
      updateProgress();
    }));
  }

  pf.style.width = '100%';
  pl.textContent = '완료!';
  setTimeout(() => { pw.style.display = 'none'; pf.style.width = '0%'; }, 600);

  payload.forEach((sheet) => {
    sheet.comps.forEach((comp) => {
      comp.verdict = decidePurchase(comp, permittedSet, permittedUnavailable);
    });
  });

  lastResultData = payload;
  renderAll(payload);
  refreshAllHistoryBars();
  document.getElementById('runBtnM').disabled = false;
}


/* ═══════════════════════════════════════════════════════════
   9. 4단계 구매 판정
   ─────────────────────────────────────────────────────────
   우선순위: 구매불가 > 검토 필요 > 구매가능(사내허가) > 구매가능
   verdict: 'BLOCK' | 'REVIEW' | 'PERMITTED' | 'OK'
   ═══════════════════════════════════════════════════════════ */
function decidePurchase(comp, permSet, permUnavailable) {
  const kr = comp.kr;
  const ko = comp.ko;

  // 조회 자체가 실패한 경우 — 판정 불가
  if (!kr || kr.success !== true || !ko || ko.success !== true) {
    return { verdict: 'REVIEW', reason: '규제 조회 실패 — 재분석이 필요합니다.', appliedUniqueNos: [] };
  }

  // 1. 금지 — 사내 허가목록보다 절대 우선
  if (kr.prohibited || ko.prohibited) {
    const reasons = [];
    if (kr.prohibited) reasons.push('K-REACH 금지물질');
    if (ko.prohibited) reasons.push('KOSHA 제조 등의 금지물질');
    return { verdict: 'BLOCK', reason: reasons.join(' / '), appliedUniqueNos: [] };
  }

  const krMatched = (kr.regulations || []).filter((r) => r.matchedByContent);
  const koMatched = ko.regulations || []; // KOSHA는 매칭된 항목만 담겨 있음

  // 2. 규제 비해당(기존화학물질 KE번호만 있는 경우 포함 — regulations에 안 들어감)
  if (!krMatched.length && !koMatched.length) {
    return { verdict: 'OK', reason: '', appliedUniqueNos: [] };
  }

  // KOSHA 규제는 사내 허가목록(CAS+K-REACH 고유번호 기준)으로 해소할 수 없음
  if (koMatched.length) {
    return {
      verdict: 'REVIEW',
      reason: 'KOSHA 규제대상(사내 허가목록으로 해소 불가) — ' + koMatched.map((r) => r.type).join(', '),
      appliedUniqueNos: [],
    };
  }

  // 3. K-REACH 규제대상 → 적용 고유번호(중복 제거) 추출
  const uniqueNos = Array.from(new Set(krMatched.map((r) => r.uniqueNo).filter(Boolean)));

  if (permUnavailable) {
    return {
      verdict: 'REVIEW',
      reason: '사내 허가목록을 확인할 수 없어 판정할 수 없습니다.',
      appliedUniqueNos: uniqueNos,
    };
  }

  if (!uniqueNos.length) {
    return {
      verdict: 'REVIEW',
      reason: '유해화학물질 고유번호를 확인하지 못했습니다.',
      appliedUniqueNos: uniqueNos,
    };
  }

  const cas = normalizeCas(comp.cas);
  const allMatched = uniqueNos.every((unq) => permSet.has(compositeKey(cas, unq)));

  if (allMatched) {
    return { verdict: 'PERMITTED', reason: '사내 허가된 유해화학물질', appliedUniqueNos: uniqueNos };
  }

  return {
    verdict: 'REVIEW',
    reason: '사내 허가목록과 일부 또는 전부 불일치',
    appliedUniqueNos: uniqueNos,
  };
}


/* ═══════════════════════════════════════════════════════════
   10. 결과 렌더링
   ═══════════════════════════════════════════════════════════ */
function verdictMeta(verdict) {
  switch (verdict) {
    case 'BLOCK':     return { icon: '⛔', label: '구매불가', cls: 'verdict-block' };
    case 'REVIEW':    return { icon: '⚠',  label: '검토 필요', cls: 'verdict-review' };
    case 'PERMITTED': return { icon: '✅', label: '구매가능', sub: '사내 허가된 유해화학물질', cls: 'verdict-permitted' };
    default:          return { icon: '✅', label: '구매가능', cls: 'verdict-ok' };
  }
}

function buildVerdictCell(v) {
  const meta = verdictMeta(v.verdict);
  const subText = meta.sub || (v.verdict !== 'OK' ? v.reason : '');
  const sub = subText ? `<div class="verdict-sub">${escHtml(subText)}</div>` : '';
  return `<td class="td-verdict"><span class="verdict-badge ${meta.cls}">${meta.icon} ${meta.label}</span>${sub}</td>`;
}

function buildKrCell(kr) {
  if (!kr || kr.success !== true) {
    const msg = (kr && kr.message) || '조회 실패';
    return `<td class="td-law" title="${escAttr(msg)}"><span class="tag-org">조회 실패</span><div class="law-note">재분석이 필요합니다</div></td>`;
  }

  const lines = [];
  if (kr.notFound) lines.push(`<span class="tag-new">신규(K-REACH 미등록)</span>`);
  if (kr.prohibited) {
    lines.push(`<div class="law-prohib">⛔ 금지물질${kr.prohibitedReason ? ' — ' + escHtml(kr.prohibitedReason) : ''}</div>`);
  }
  (kr.regulations || []).filter((r) => r.matchedByContent).forEach((r) => {
    const parts = [r.type];
    if (r.hazardCategory) parts.push(r.hazardCategory);
    if (r.criterion) parts.push(r.criterion);
    let line = parts.join(' ');
    if (r.uniqueNo) line += ` (${r.uniqueNo})`;
    lines.push(`<div class="law-line">${escHtml(line)}</div>`);
  });
  if (kr.existingChemical && kr.existingChemical.matched) {
    lines.push(`<span class="tag-gray">기존화학물질 (${escHtml(kr.existingChemical.keNo)})</span>`);
  }
  (kr.infoTags || []).forEach((t) => lines.push(`<span class="tag-gray">${escHtml(t.type)}</span>`));

  if (!lines.length) return `<td class="td-law">규제기준 비해당</td>`;
  return `<td class="td-law">${lines.join('')}</td>`;
}

function buildKoCell(ko) {
  if (!ko || ko.success !== true) {
    const msg = (ko && ko.message) || '조회 실패';
    return `<td class="td-law" title="${escAttr(msg)}"><span class="tag-org">조회 실패</span><div class="law-note">재분석이 필요합니다</div></td>`;
  }

  const lines = [];
  if (ko.notFound) lines.push(`<span class="tag-new">신규(KOSHA 미등록)</span>`);
  (ko.regulations || []).forEach((r) => {
    const isProhibit = r.type === '제조 등의 금지물질';
    lines.push(`<div class="${isProhibit ? 'law-prohib' : 'law-line'}">${isProhibit ? '⛔ ' : ''}${escHtml(r.type)}</div>`);
  });

  if (!lines.length) return `<td class="td-law">규제기준 비해당</td>`;
  return `<td class="td-law">${lines.join('')}</td>`;
}

function renderAll(payload) {
  lastResultData = payload;
  const ra = document.getElementById('resultArea');
  let html = '';

  payload.forEach((sheet, fi) => {
    const fname = sheet.filename || `MSDS ${fi + 1}`;
    const comps = sheet.comps || [];

    const counts = { OK: 0, PERMITTED: 0, REVIEW: 0, BLOCK: 0 };
    comps.forEach((c) => { counts[c.verdict.verdict] = (counts[c.verdict.verdict] || 0) + 1; });

    let overall = 'OK';
    if (counts.BLOCK) overall = 'BLOCK';
    else if (counts.REVIEW) overall = 'REVIEW';
    else if (counts.PERMITTED) overall = 'PERMITTED';

    const overallMeta = verdictMeta(overall);
    let bannerTitle;
    let bannerDetail;
    if (overall === 'BLOCK') {
      bannerTitle = '제품 구매불가';
      bannerDetail = `금지물질 성분 ${counts.BLOCK}종 포함`;
    } else if (overall === 'REVIEW') {
      bannerTitle = '제품 구매 전 검토 필요';
      bannerDetail = `전체 ${comps.length}종 / 사내 허가물질 ${counts.PERMITTED}종 / 검토필요 ${counts.REVIEW}종`;
    } else if (overall === 'PERMITTED') {
      bannerTitle = '제품 구매가능';
      bannerDetail = `사내 허가된 유해화학물질 ${counts.PERMITTED}종 포함`;
    } else {
      bannerTitle = '제품 구매가능';
      bannerDetail = `전체 ${comps.length}개 성분 중 규제 검토 대상 없음`;
    }

    html += `<div class="card" style="margin-bottom:${fi < payload.length - 1 ? '6px' : '14px'}">
      <div class="card-head">📦 구성성분 + 규제정보 — ${escHtml(fname)}
        <span class="sec-badge b-gray" style="margin-left:auto">${comps.length}종</span>
      </div>
      <div class="summary-banner ${overallMeta.cls}">
        <span class="summary-icon">${overallMeta.icon}</span>
        <div class="summary-text">
          <div class="summary-title">${escHtml(bannerTitle)}</div>
          <div class="summary-detail">${escHtml(bannerDetail)}</div>
        </div>
        <button class="loc-btn" id="locBtn-${fi}" onclick="generateLoc(${fi})">📄 LOC 확인서(Word) 다운로드</button>
      </div>
      <div class="card-body" style="padding-top:8px">
      <div class="tbl-wrap"><table class="reg">
        <thead>
          <tr>
            <th class="th-info" rowspan="2" style="width:30px;text-align:center">#</th>
            <th class="th-info" rowspan="2" style="min-width:130px">화학물질명</th>
            <th class="th-info" rowspan="2">CAS No</th>
            <th class="th-inp" colspan="2">성분함량</th>
            <th class="th-info" rowspan="2">판정</th>
            <th class="th-kr">화평법 (K-REACH)</th>
            <th class="th-ko">산안법 (KOSHA)</th>
          </tr>
          <tr>
            <th class="th-inp">최소(%)</th>
            <th class="th-inp">최대(%)</th>
            <th class="th-kr">유해성·규제정보</th>
            <th class="th-ko">유해성·규제정보</th>
          </tr>
        </thead>
        <tbody>`;

    if (!comps.length) {
      html += `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">
        구성성분 정보가 없습니다.</td></tr>`;
    }

    comps.forEach((comp, ci) => {
      const kr = comp.kr || {};
      const nmKor = (kr.chemicalNameKor || '').trim();
      const nmEng = (kr.chemicalNameEn || '').trim();
      let nmCell;
      if (nmKor)
        nmCell = `<td class="td-nm">${escHtml(nmKor)}${nmEng ? `<br><span style="font-size:10px;color:var(--muted);font-weight:400">(${escHtml(nmEng)})</span>` : ''}</td>`;
      else if (nmEng)
        nmCell = `<td class="td-nm">${escHtml(nmEng)}</td>`;
      else
        nmCell = `<td class="td-nm" style="color:var(--muted);font-style:italic;font-size:11px">미조회<br><span style="font-size:9px">${escHtml(comp.cas)}</span></td>`;

      const minTd = comp.min != null ? `<td class="td-num">${comp.min}%</td>` : `<td class="cd">—</td>`;
      let maxTd;
      if (comp.max != null) {
        const sign = comp.isLt ? '<' : '≤';
        const title = comp.isLt ? `${comp.max}% 미포함(미만)` : `${comp.max}% 포함(이하)`;
        maxTd = `<td class="td-num" title="${title}">${sign}${comp.max}%</td>`;
      } else {
        maxTd = `<td class="cd">—</td>`;
      }

      html += `<tr class="${ci > 0 ? 'row-sep' : ''}">
        <td style="text-align:center;font-size:12px;font-weight:700;color:var(--muted)">${ci + 1}</td>
        ${nmCell}
        <td class="td-cas">${escHtml(comp.cas)}</td>
        ${minTd}${maxTd}
        ${buildVerdictCell(comp.verdict)}
        ${buildKrCell(comp.kr)}
        ${buildKoCell(comp.ko)}
      </tr>`;
    });

    html += `</tbody></table></div></div></div>`;
  });

  const uid = 'raw-' + Math.random().toString(36).slice(2, 6);
  html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px;gap:8px;flex-wrap:wrap">
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button id="copyResultBtn" class="copy-result-btn" onclick="copyResultsAsText(false)">
        📋 전체 결과 복사
      </button>
      <button id="copyRegulatedBtn" class="copy-result-btn" style="background:linear-gradient(90deg,#b91c1c,#7f1d1d)" onclick="copyResultsAsText(true)">
        ⚠️ 규제대상만 복사
      </button>
    </div>
    <button class="raw-toggle" onclick="toggleEl('${uid}')">▼ 원본 데이터 보기</button>
  </div>
  <div id="${uid}" class="raw-box">${escHtml(JSON.stringify(payload, null, 2))}</div>`;

  ra.innerHTML = html;
  ra.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


/* ═══════════════════════════════════════════════════════════
   결과 복사 (전체 / 규제대상만)
   ═══════════════════════════════════════════════════════════ */
function copyResultsAsText(regulatedOnly = false) {
  if (!lastResultData) return;

  const blocks = lastResultData.map((sheet) => {
    const fname = (sheet.filename || '').trim() || 'MSDS';
    const comps = regulatedOnly
      ? (sheet.comps || []).filter((c) => c.verdict && c.verdict.verdict !== 'OK')
      : (sheet.comps || []);

    const lines = [`제품명 : ${fname}`, ''];

    if (!comps.length) {
      lines.push(regulatedOnly ? '\t(규제대상 물질 없음)' : '\t(구성성분 없음)');
      return lines.join('\n');
    }

    comps.forEach((comp, ci) => {
      const kr = comp.kr || {};
      const ko = comp.ko || {};
      const nmKor = (kr.chemicalNameKor || '').trim();
      const nmEng = (kr.chemicalNameEn || '').trim();
      const namePart = nmKor && nmEng ? `${nmKor} (${nmEng})` : (nmKor || nmEng || comp.cas);

      let qtyPart = '함량 미상';
      if (comp.min != null && comp.max != null) qtyPart = `${comp.min}%~${comp.max}%${comp.isLt ? ' 미만' : ''}`;
      else if (comp.max != null) qtyPart = `${comp.max}%${comp.isLt ? ' 미만' : ' 이하'}`;
      else if (comp.min != null) qtyPart = `${comp.min}% 이상`;

      const meta = verdictMeta(comp.verdict.verdict);
      const verdictText = meta.sub ? `${meta.label}(${meta.sub})` : meta.label;

      const krParts = [];
      if (kr.success === false) krParts.push('K-REACH 조회 실패');
      else if (kr.notFound) krParts.push('신규화학물질');
      else {
        if (kr.prohibited) krParts.push(`화평법 금지물질${kr.prohibitedReason ? '(' + kr.prohibitedReason + ')' : ''}`);
        (kr.regulations || []).filter((r) => r.matchedByContent).forEach((r) => {
          const p = [r.type, r.hazardCategory, r.criterion].filter(Boolean).join(' ');
          krParts.push(r.uniqueNo ? `${p} (${r.uniqueNo})` : p);
        });
        if (kr.existingChemical && kr.existingChemical.matched) {
          krParts.push(`기존화학물질(${kr.existingChemical.keNo})`);
        }
        if (!krParts.length) krParts.push('규제기준 비해당');
      }

      const koParts = [];
      if (ko.success === false) koParts.push('KOSHA 조회 실패');
      else if (ko.notFound) koParts.push('신규화학물질(KOSHA)');
      else if (!(ko.regulations || []).length) koParts.push('규제기준 비해당');
      else (ko.regulations || []).forEach((r) => koParts.push(r.type));

      lines.push(`\t${ci + 1}. ${namePart} CAS NO. ${comp.cas} 물질 ${qtyPart} 함유 [판정: ${verdictText}]`);
      lines.push(`\t   K-REACH: ${krParts.join(' / ')}`);
      lines.push(`\t   KOSHA: ${koParts.join(' / ')}`);
    });

    return lines.join('\n');
  });

  const text    = blocks.join('\n\n');
  const btnId   = regulatedOnly ? 'copyRegulatedBtn' : 'copyResultBtn';
  const origTxt = regulatedOnly ? '⚠️ 규제대상만 복사' : '📋 전체 결과 복사';
  const btn     = document.getElementById(btnId);

  const onDone = () => {
    if (btn) {
      btn.textContent = '✅ 복사됨!';
      setTimeout(() => { btn.textContent = origTxt; }, 1800);
    }
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onDone).catch(() => fallbackCopy(text, onDone));
  } else {
    fallbackCopy(text, onDone);
  }
}

function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  if (typeof onDone === 'function') onDone();
}


/* ═══════════════════════════════════════════════════════════
   11. 사내 허가목록 관리 모달
   ═══════════════════════════════════════════════════════════ */
function openPermittedModal() {
  const modal = document.getElementById('permittedModal');
  if (modal) modal.style.display = 'flex';
  renderPermittedTable();
}

function closePermittedModal() {
  const modal = document.getElementById('permittedModal');
  if (modal) modal.style.display = 'none';
}

function renderPermittedTable() {
  const body = document.getElementById('permittedTableBody');
  if (!body) return;

  const casQ = (document.getElementById('permittedSearchCas')?.value || '').trim().toLowerCase();
  const unqQ = (document.getElementById('permittedSearchUnq')?.value || '').trim().toLowerCase();

  const filtered = permittedItems.filter((it) =>
    (!casQ || it.casNo.toLowerCase().includes(casQ)) &&
    (!unqQ || it.uniqueNo.toLowerCase().includes(unqQ))
  );

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:16px">등록된 항목이 없습니다.</td></tr>`;
  } else {
    body.innerHTML = filtered.map((it) => `
      <tr>
        <td class="td-cas">${escHtml(it.casNo)}</td>
        <td>${escHtml(it.uniqueNo)}</td>
        <td style="text-align:center">
          <button class="rm-btn" onclick="deletePermittedItem('${escAttr(it.casNo)}','${escAttr(it.uniqueNo)}')">✕</button>
        </td>
      </tr>`).join('');
  }

  const countEl = document.getElementById('permittedCount');
  if (countEl) {
    countEl.textContent = `등록 ${permittedItems.length}건` +
      (filtered.length !== permittedItems.length ? ` (검색결과 ${filtered.length}건)` : '');
  }
}

async function submitPermittedRequest(mode, items) {
  const msgBox = document.getElementById('permittedMsgBox');
  if (msgBox) msgBox.innerHTML = '⏳ 저장 중...';

  try {
    const r = await fetch('/api/permitted-chems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, items }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();

    if (!d.success) {
      if (msgBox) {
        let msg = `<div class="err-box">저장 실패: ${escHtml(d.message || '')}</div>`;
        if (d.errors && d.errors.length) {
          msg += `<ul class="permitted-errors">` +
            d.errors.map((e) => `<li>${e.row}행: ${escHtml(e.reason)}</li>`).join('') + `</ul>`;
        }
        msgBox.innerHTML = msg;
      }
      return;
    }

    permittedItems = d.items || [];
    permittedSet = new Set(permittedItems.map((it) => compositeKey(it.casNo, it.uniqueNo)));
    permittedUnavailable = false;

    let msg = `✅ 저장 완료 (현재 ${permittedItems.length}건)`;
    if (d.errors && d.errors.length) {
      msg += `<div style="color:var(--orange);margin-top:6px">⚠️ 일부 행 저장 실패</div>` +
        `<ul class="permitted-errors">` +
        d.errors.map((e) => `<li>${e.row}행: ${escHtml(e.reason)}</li>`).join('') + `</ul>`;
    }
    if (msgBox) msgBox.innerHTML = msg;
    renderPermittedTable();
  } catch (e) {
    if (msgBox) msgBox.innerHTML = `<div class="err-box">저장 실패: ${escHtml(e.message || '')}</div>`;
  }
}

function addPermittedSingle() {
  const casEl = document.getElementById('permittedNewCas');
  const unqEl = document.getElementById('permittedNewUnq');
  const cas = casEl?.value || '';
  const unq = unqEl?.value || '';
  if (!cas.trim() || !unq.trim()) { alert('CAS 번호와 유해화학물질 고유번호를 모두 입력하세요.'); return; }
  submitPermittedRequest('append', [{ casNo: cas, uniqueNo: unq }]);
  if (casEl) casEl.value = '';
  if (unqEl) unqEl.value = '';
}

function parseBulkPermittedText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  lines.forEach((line, idx) => {
    if (idx === 0 && /cas/i.test(line) && /(고유번호|unique)/i.test(line)) return; // 헤더 줄 스킵
    const parts = line.includes(',') ? line.split(',') : line.split(/\t|\s{2,}/);
    if (parts.length < 2) return;
    items.push({ casNo: parts[0], uniqueNo: parts[1] });
  });
  return items;
}

function submitPermittedBulk(mode) {
  const textEl = document.getElementById('permittedBulkText');
  const items = parseBulkPermittedText(textEl?.value || '');
  if (!items.length) { alert('입력된 항목이 없습니다.'); return; }
  if (mode === 'replace' && !confirm('전체 목록을 여기 입력한 내용으로 교체합니다. 계속할까요?')) return;
  submitPermittedRequest(mode, items);
}

function handlePermittedCsvUpload(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const textEl = document.getElementById('permittedBulkText');
    if (textEl) textEl.value = String(reader.result || '');
  };
  reader.readAsText(file, 'utf-8');
  evt.target.value = '';
}

function deletePermittedItem(cas, unq) {
  if (!confirm(`${cas} / ${unq} 항목을 삭제할까요?`)) return;
  submitPermittedRequest('delete', [{ casNo: cas, uniqueNo: unq }]);
}

function downloadPermittedCsv() {
  const rows = ['cas_no,unique_no', ...permittedItems.map((it) => `${it.casNo},${it.uniqueNo}`)];
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, 'permitted_chems.csv');
}


/* ═══════════════════════════════════════════════════════════
   12. LOC(Word) 확인서 자동 생성
   ─────────────────────────────────────────────────────────
   docxtemplater/PizZip을 CDN에서 로드해 브라우저에서 직접 생성한다
   (index.html에 <script> 태그로 포함되어 있어야 함).
   환경(K-REACH) 문서와 산안법(KOSHA) 문서 두 개를 순차 다운로드한다.

   v_acc(사고대비물질) 플래그는 K-REACH 사고대비물질만 반영한다.
   KOSHA 특별관리물질은 별개 법령(산업안전보건법)이므로 의도적으로
   병합하지 않는다.
   ═══════════════════════════════════════════════════════════ */
function safeFileName(name) {
  return String(name || 'MSDS').replace(/[\\/:*?"<>|]/g, '_').trim() || 'MSDS';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function loadTemplateArrayBuffer(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('템플릿 파일을 불러올 수 없습니다: ' + path);
  return r.arrayBuffer();
}

function renderDocxFromTemplate(arrayBuffer, data) {
  const zip = new window.PizZip(arrayBuffer);
  const doc = new window.docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data);
  return doc.getZip().generate({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

function buildLocComps(comps) {
  return (comps || []).map((comp) => {
    const kr = (comp.kr && comp.kr.success) ? comp.kr : {};
    const ko = (comp.ko && comp.ko.success) ? comp.ko : {};
    const name = (kr.chemicalNameKor || kr.chemicalNameEn || comp.cas || '').trim();

    const isToxic = (kr.regulations || []).some((r) => r.type === '유독물질' && r.matchedByContent);
    const hasHazardCat = (cat) => (kr.regulations || []).some((r) => r.hazardCategory === cat && r.matchedByContent);
    const hasType = (type) => (kr.regulations || []).some((r) => r.type === type && r.matchedByContent);

    return {
      name,
      cas: comp.cas || '',
      min: comp.min != null ? String(comp.min) : '',
      max: comp.max != null ? String(comp.max) : '',
      p_n: kr.existingChemical && kr.existingChemical.matched ? 'P' : 'N',
      v_acute:   (isToxic || hasHazardCat('급성')) ? 'V' : '',
      v_chronic: (isToxic || hasHazardCat('만성')) ? 'V' : '',
      v_env:     (isToxic || hasHazardCat('생태')) ? 'V' : '',
      v_perm:    hasType('허가물질') ? 'V' : '',
      v_rest:    hasType('제한물질') ? 'V' : '',
      v_prohib:  (kr.prohibited || ko.prohibited) ? 'V' : '',
      v_acc:     hasType('사고대비물질') ? 'V' : '', // KOSHA 특별관리물질은 의도적으로 미포함
    };
  });
}

async function generateLoc(sheetIndex) {
  const sheet = lastResultData && lastResultData[sheetIndex];
  if (!sheet) return;

  const btn = document.getElementById('locBtn-' + sheetIndex);
  const origTxt = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ LOC 생성 중...'; }

  try {
    if (!window.PizZip || !window.docxtemplater) {
      throw new Error('LOC 생성 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    }

    const productName = sheet.filename || 'MSDS';
    const comps = buildLocComps(sheet.comps);
    const fileBase = safeFileName(productName);

    const envBuf = await loadTemplateArrayBuffer(encodeURI('/Letter_of_Confirmation(environment).docx'));
    const envBlob = renderDocxFromTemplate(envBuf, { product_name: productName, comps });
    downloadBlob(envBlob, `LOC_${fileBase}_environment.docx`);

    await new Promise((r) => setTimeout(r, 400));

    const healthBuf = await loadTemplateArrayBuffer(encodeURI('/Letter_of_Confirmation(health).docx'));
    const healthBlob = renderDocxFromTemplate(healthBuf, { product_name: productName });
    downloadBlob(healthBlob, `LOC_${fileBase}_health.docx`);
  } catch (e) {
    const detail = e && e.properties && e.properties.errors
      ? e.properties.errors.map((x) => x.message || x.name).join(', ')
      : (e && e.message) || String(e);
    alert('LOC 생성 실패: ' + detail);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origTxt || '📄 LOC 확인서(Word) 다운로드'; }
  }
}


/* ═══════════════════════════════════════════════════════════
   13. 유틸리티
   ═══════════════════════════════════════════════════════════ */
function showError(msg) {
  document.getElementById('resultArea').innerHTML = `
    <div class="err-box">
      <strong>⚠️ 오류 발생</strong>
      ${msg}
    </div>`;
}

function toggleEl(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === 'block' ? 'none' : 'block';
}

function escHtml(s) {
  return (s || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escAttr(s) {
  return (s || '').toString().replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

/* ── 페이지 초기화 ──────────────────────────────────────── */
window.addEventListener('load', function () {
  loadPermittedListAndStatus();
  addMsdsSheet('');
});
