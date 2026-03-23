/* ============================================================
   app.js — MSDS 직접입력 분석 포털 (로직 전담)

   [구조 개요]
   1. 상수/전역 상태
   2. 서버 연결 확인
   3. MSDS 시트 관리 (addMsdsSheet / removeMsdsSheet)
   4. 직접입력 행 관리 (addManualRow)
   5. 키보드 탐색 (화살표키 / Tab / Enter)
   6. CAS 번호 자동 포맷 (formatCAS / onCASInput)
   7. 분석 실행 (doManual → fetch → renderAll)
   8. 결과 렌더링 헬퍼 함수들
   9. 에러 표시 / 유틸
   ============================================================ */


/* ═══════════════════════════════════════════════════════════
   1. 상수 / 전역 상태
   ─────────────────────────────────────────────────────────
   PROXY: Flask 서버 주소 (배포 시 실제 도메인으로 교체)
   sheetId, rowId: 시트·행 고유 ID 카운터
   ═══════════════════════════════════════════════════════════ */
const PROXY = 'https://chemicalevaluation-api.onrender.com';

let sheetId = 0;   // MSDS 시트 순번
let rowId   = 0;   // 입력 행 순번


/* ═══════════════════════════════════════════════════════════
   2. 서버 연결 확인
   ─────────────────────────────────────────────────────────
   페이지 로드 시 Flask 프록시 서버의 / 엔드포인트를 호출하여
   K-REACH / KOSHA 서비스 정상 여부를 상태 바에 표시합니다.
   ═══════════════════════════════════════════════════════════ */
async function checkServer() {
  const txt = document.getElementById('srvTxt');
  const bar = document.getElementById('srvBar');
  txt.textContent = '서버 연결 확인 중... (최대 60초 소요)';
  try {
    const r = await fetch(PROXY + '/', { signal: AbortSignal.timeout(60000) });
    const d = await r.json();
    const ok = d.services?.kreach === '정상' && d.services?.kosha === '정상';
    txt.textContent = ok ? '✅ 서버 정상 — K-REACH · KOSHA 준비됨' : '⚠️ 서버 연결됨 (일부 서비스 점검 중)';
    if (bar) bar.style.color = ok ? 'var(--green)' : 'var(--orange)';
  } catch {
    txt.textContent = '❌ 서버 연결 실패 (재시도 중...)';
    if (bar) bar.style.color = 'var(--red)';
    setTimeout(checkServer, 10000);
  }
}


/* ═══════════════════════════════════════════════════════════
   3. MSDS 시트 관리
   ─────────────────────────────────────────────────────────
   addMsdsSheet(name)  : 시트(카드) 1개를 DOM에 추가
   removeMsdsSheet(sid): 해당 시트를 DOM에서 제거
   ═══════════════════════════════════════════════════════════ */
function addMsdsSheet(name) {
  sheetId++;
  const sid = sheetId;
  const container = document.getElementById('msdsSheets');

  /* 외부 시트 div */
  const sheet = document.createElement('div');
  sheet.className = 'msds-sheet';
  sheet.id = 'sheet-' + sid;

  /* 시트 헤더 (이름 입력 + 삭제 버튼) */
  const head = document.createElement('div');
  head.className = 'msds-sheet-head';
  head.innerHTML = `
    <input type="text" placeholder="MSDS 제품명 (예: 톨루엔 MSDS)" value="${escHtml(name)}">
    <button class="msds-rm-btn" onclick="removeMsdsSheet(${sid})">✕ 시트 삭제</button>
  `;

  /* 시트 바디 (열 헤더 + 행 컨테이너 + 행 추가 버튼) */
  const body = document.createElement('div');
  body.className = 'msds-sheet-body';
  body.id = 'sheet-body-' + sid;
  body.innerHTML = `
    <div class="manual-header">
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

  /* 첫 행 자동 추가 */
  addManualRow(sid, '', null, null, false);
}

function removeMsdsSheet(sid) {
  const el = document.getElementById('sheet-' + sid);
  if (el) el.remove();
}


/* ═══════════════════════════════════════════════════════════
   4. 직접입력 행 관리
   ─────────────────────────────────────────────────────────
   addManualRow(sid, cas, min, max, isLt)
     sid  : 부모 시트 ID
     cas  : CAS 번호 초기값
     min  : 최소 함량 (null 허용)
     max  : 최대 함량 (null 허용)
     isLt : true = 미만(<) 체크 상태
   ═══════════════════════════════════════════════════════════ */
function addManualRow(sid, cas, min, max, isLt) {
  const id = ++rowId;
  const container = document.getElementById('rows-' + sid);
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'manual-row';
  row.id = 'mrow-' + id;
  row.dataset.sheet = sid;

  /* CAS 번호 입력 */
  const casInput = document.createElement('input');
  casInput.type = 'text';
  casInput.placeholder = '예: 108-88-3';
  casInput.value = String(cas || '');
  casInput.id = 'cas-' + id;
  casInput.maxLength = 12;
  casInput.setAttribute('oninput', 'onCASInput(this)');

  /* 최소 함량 */
  const minInput = document.createElement('input');
  minInput.type = 'number';
  minInput.placeholder = '0';
  minInput.min = '0'; minInput.max = '100'; minInput.step = '0.01';
  minInput.value = (min !== null && min !== '') ? min : '';
  minInput.id = 'min-' + id;

  /* 최대 함량 */
  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.placeholder = '100';
  maxInput.min = '0'; maxInput.max = '100'; maxInput.step = '0.01';
  maxInput.value = (max !== null && max !== '') ? max : '';
  maxInput.id = 'max-' + id;

  /* 미만 체크박스 */
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

  /* 행 삭제 버튼 */
  const rmBtn = document.createElement('button');
  rmBtn.className = 'rm-btn';
  rmBtn.title = '삭제';
  rmBtn.textContent = '✕';
  rmBtn.addEventListener('click', function () { row.remove(); });

  row.appendChild(casInput);
  row.appendChild(minInput);
  row.appendChild(maxInput);
  row.appendChild(label);
  row.appendChild(rmBtn);
  container.appendChild(row);
}


/* ═══════════════════════════════════════════════════════════
   5. 키보드 탐색
   ─────────────────────────────────────────────────────────
   직접입력 행 안에서:
     Tab / Enter → 다음 셀 (행 끝이면 다음 행 첫 셀)
     ← → → 같은 행 이전/다음 입력
     ↑ ↓ → 같은 열의 위/아래 행
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', function (e) {
  const el = e.target;
  if (!el.closest('.manual-row')) return;
  if (!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Enter','Tab'].includes(e.key)) return;

  const row      = el.closest('.manual-row');
  const rowsDiv  = row.parentElement;
  const allRows  = [...rowsDiv.querySelectorAll('.manual-row')];
  const inputs   = [...row.querySelectorAll('input')];
  const colIdx   = inputs.indexOf(el);
  const rowIdx   = allRows.indexOf(row);

  if (e.key === 'Tab' || e.key === 'Enter') {
    if (el.type === 'checkbox') return;
    e.preventDefault();
    const next = inputs[colIdx + 1];
    if (next) { next.focus(); if (next.select) next.select(); }
    else {
      const nextRow = allRows[rowIdx + 1];
      if (nextRow) {
        const fi = nextRow.querySelector('input[type="text"],input[type="number"]');
        if (fi) { fi.focus(); if (fi.select) fi.select(); }
      }
    }
    return;
  }

  if (e.key === 'ArrowRight' && el.type !== 'checkbox') {
    const atEnd = el.type === 'number' ? true : el.selectionStart === el.value.length;
    if (!atEnd) return;
    const next = inputs[colIdx + 1];
    if (next && next.type !== 'checkbox') { e.preventDefault(); next.focus(); if (next.select) next.select(); }
    return;
  }
  if (e.key === 'ArrowLeft' && el.type !== 'checkbox') {
    const atStart = el.type === 'number' ? true : el.selectionStart === 0;
    if (!atStart) return;
    const prev = inputs[colIdx - 1];
    if (prev && prev.type !== 'checkbox') {
      e.preventDefault(); prev.focus();
      if (prev.type === 'text') { const len = prev.value.length; prev.setSelectionRange(len, len); }
    }
    return;
  }

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const targetRow    = allRows[rowIdx + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!targetRow) return;
    const targetInputs = [...targetRow.querySelectorAll('input')];
    const targetEl     = targetInputs[colIdx] || targetInputs[0];
    if (targetEl) { targetEl.focus(); if (targetEl.select) targetEl.select(); }
  }
});


/* ═══════════════════════════════════════════════════════════
   6. CAS 번호 자동 하이픈 포맷
   ─────────────────────────────────────────────────────────
   입력 중 숫자를 자동으로 "XXXXXXX-XX-X" 형식으로 변환합니다.
   onCASInput(el): input[oninput] 핸들러
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
   7. 분석 실행
   ─────────────────────────────────────────────────────────
   doManual():
     1) 모든 MSDS 시트에서 입력값 수집
     2) POST /api/manual/analyze 호출
     3) 응답 → renderAll()
   buildRawText(): 함량 범위 표시 텍스트 생성
   ═══════════════════════════════════════════════════════════ */
function buildRawText(min, max, isLt) {
  if (min != null && max != null) return min + '~' + max + '%' + (isLt ? ' 미만' : '');
  if (max != null) return max + '%' + (isLt ? ' 미만' : '');
  if (min != null) return min + '%';
  return '';
}

async function doManual() {
  const sheets = [...document.getElementById('msdsSheets').children];
  if (!sheets.length) { alert('MSDS를 1개 이상 추가하세요.'); return; }

  /* 입력값 수집 */
  const payload = [];
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
      comps.push({
        cas_no:       cas,
        ke_no:        '',
        함량원문:     buildRawText(minV, maxV, isLt),
        함량최소:     minV,
        함량최대:     maxV,
        최대포함여부: !isLt,
        최소포함여부: true,
      });
    }
    if (comps.length) payload.push({ filename, comps });
  }

  if (!payload.length) { alert('CAS번호를 1개 이상 입력하세요.'); return; }

  const totalComps = payload.reduce((s, r) => s + r.comps.length, 0);

  /* UI: 버튼 비활성 + 진행 바 */
  document.getElementById('runBtnM').disabled = true;
  const pw = document.getElementById('progWrapM');
  const pf = document.getElementById('progFillM');
  const pl = document.getElementById('progLabelM');
  pw.style.display = 'block';

  let pct = 0;
  const tmr = setInterval(() => {
    if (pct < 88) { pct += 3; pf.style.width = pct + '%'; }
    pl.textContent = `K-REACH · KOSHA 조회 중... (${payload.length}개 MSDS / ${totalComps}종)`;
  }, 400);

  try {
    const r = await fetch(PROXY + '/api/manual/analyze', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sheets: payload }),
      signal:  AbortSignal.timeout(180000),
    });
    const text = await r.text();
    let d;
    try   { d = JSON.parse(text); }
    catch (e) {
      clearInterval(tmr); pw.style.display = 'none';
      showError('서버 응답 파싱 실패: ' + text.slice(0, 300));
      document.getElementById('runBtnM').disabled = false;
      return;
    }
    clearInterval(tmr);
    pf.style.width = '100%';
    pl.textContent = '완료!';
    setTimeout(() => { pw.style.display = 'none'; pf.style.width = '0%'; }, 600);

    if (!r.ok || d.error) showError(d.error || `HTTP ${r.status}`);
    else                   renderAll(d);

  } catch (e) {
    clearInterval(tmr);
    pw.style.display = 'none';
    showError(e.message.includes('timeout') ? '응답 시간 초과 (180초)' : e.message);
  }
  document.getElementById('runBtnM').disabled = false;
}


/* ═══════════════════════════════════════════════════════════
   8. 결과 렌더링 헬퍼
   ─────────────────────────────────────────────────────────
   각 함수는 테이블 <td> HTML 문자열을 반환합니다.
   ═══════════════════════════════════════════════════════════ */

/* K-REACH 규제함량 셀
   - 금지물질: '완전금지' (함량 무관)
   - 기타: 최대함량이 기준 이상일 때만 기준값 표시 */
function buildKrConc(kr, cMax, maxIncluded) {
  if (!kr || (kr.not_found && !kr['금지'])) return `<td class="cd" title="K-REACH 미등록">—</td>`;
  if (kr.error) return `<td class="cd" title="${escAttr(kr.error)}">오류</td>`;

  if (kr['금지'] === 'Y') {
    return `<td style="background:#1a1a2e;color:#fbbf24;font-weight:700;font-size:11px;text-align:center"
              title="${escAttr(kr['금지_근거'] || '금지물질')}">완전금지</td>`;
  }

  const regs = [];
  (kr['유해_기준표'] || []).forEach(r => {
    if (r['기준값'] != null) regs.push({ name: r['카테고리'], thr: r['기준값'] });
  });
  if (kr['사고대비'] === 'Y') {
    const m = (kr['사고대비_기준'] || '').match(/(\d+(?:\.\d+)?)/);
    if (m) regs.push({ name: '사고대비', thr: parseFloat(m[1]) });
  }
  ['유독', '허가', '제한'].forEach(c => { if (kr[c] === 'Y') regs.push({ name: c, thr: null }); });

  if (!regs.length) return `<td class="cd">—</td>`;

  const thrs   = regs.filter(r => r.thr != null).map(r => r.thr);
  const minThr = thrs.length ? Math.min(...thrs) : null;

  if (minThr != null && cMax != null) {
    const exceeded = maxIncluded ? cMax >= minThr : cMax > minThr;
    if (!exceeded) {
      const sign = maxIncluded ? `${cMax}% ≤` : `${cMax}% 미만`;
      return `<td class="cd" title="${sign} < 규제기준 ${minThr}%">—</td>`;
    }
  }

  const concText = minThr != null ? `${minThr}% 이상` : '해당';
  const tip      = regs.map(r => r.name + (r.thr != null ? ` ≥${r.thr}%` : '')).join(' / ');
  const excp     = (kr['유해물질_예외조건'] || '').trim();

  return `<td style="text-align:center;padding:4px 6px"
            title="${escAttr(tip + (excp ? ' / 예외: ' + excp : ''))}">
    <div style="font-size:12px;font-weight:700;color:var(--red)">${concText}</div>
    ${excp ? `<div style="font-size:10px;color:var(--orange);line-height:1.3;margin-top:2px">※ ${escHtml(excp)}</div>` : ''}
  </td>`;
}

/* K-REACH 유해성여부 셀 */
function buildKrHazard(kr) {
  if (!kr || (kr.not_found && !kr['금지'])) return `<td class="cd">—</td>`;
  if (kr.error) return `<td class="cd" title="${escAttr(kr.error)}">오류</td>`;

  const lines = [];
  ['유독', '허가', '제한', '중점'].forEach(c => { if (kr[c] === 'Y') lines.push(`<span class="tag-org">${c}</span>`); });
  if (kr['사고대비'] === 'Y') {
    const b = kr['사고대비_기준'] ? ` ≥${kr['사고대비_기준']}` : '';
    lines.push(`<span class="tag-org">사고대비${b}</span>`);
  }
  (kr['유해_기준표'] || []).forEach(r => {
    if (r['기준값'] != null)
      lines.push(`<span class="tag-yel">${escHtml(r['카테고리'])} ≥${r['기준값']}%</span>`);
  });
  const isHazardous = lines.length > 0;
  if (!isHazardous && kr['기존화학_ke'])
    lines.push(`<span class="tag-gray">기존 ${escHtml(kr['기존화학_ke'])}</span>`);

  if (!lines.length) return `<td class="cd">—</td>`;
  return `<td style="padding:4px 6px;text-align:left"><div style="line-height:1.8">${lines.join(' ')}</div></td>`;
}

/* K-REACH 고시일자 셀 */
function buildKrDate(kr) {
  if (!kr || kr.not_found || kr.error) return `<td class="cd">—</td>`;
  const d    = kr['고시일자'] || '';
  const isHz = kr['유해판정'] === 'Y' || ['금지','유독','허가','제한','사고대비'].some(c => kr[c] === 'Y');
  if (!isHz || !d) return `<td class="cd">—</td>`;
  return `<td style="text-align:center;font-size:11px;color:#374151">${d}</td>`;
}

/* K-REACH 고유번호 셀 */
function buildKrUnqNo(kr) {
  if (!kr || kr.not_found || kr.error) return `<td class="cd">—</td>`;
  const unq = (kr['유해물질_고유번호'] || '').trim();
  if (!unq) return `<td class="cd">—</td>`;
  return `<td style="text-align:center;font-size:11px;color:#374151;white-space:nowrap">${escHtml(unq)}</td>`;
}

/* KOSHA 규제함량 셀 */
function buildKoConc(ko) {
  if (!ko || ko.not_found) return `<td class="cd">—</td>`;
  if (ko.error) return `<td class="cd" title="${escAttr(ko.error)}">미응답</td>`;
  const isReg = ko['금지'] === 'Y' || ko['특별관리'] === 'Y';
  if (!isReg) return `<td class="cd">—</td>`;
  return `<td style="text-align:center;font-size:12px;font-weight:700;color:var(--red)">해당</td>`;
}

/* KOSHA 유해성여부 셀 */
function buildKoHazard(ko) {
  if (!ko || ko.not_found) return `<td class="cd">—</td>`;
  if (ko.error) return `<td class="cd" title="${escAttr(ko.error)}">미응답</td>`;
  const lines = [];
  if (ko['금지'] === 'Y')    lines.push(`<span class="tag-red">금지물질</span>`);
  if (ko['특별관리'] === 'Y') lines.push(`<span class="tag-yel">특별관리</span>`);
  if (!lines.length) return `<td class="cd">—</td>`;
  return `<td style="padding:4px 6px;text-align:left"><div style="line-height:1.8">${lines.join(' ')}</div></td>`;
}


/* ═══════════════════════════════════════════════════════════
   renderAll — 서버 응답 전체를 결과 영역에 렌더링
   ─────────────────────────────────────────────────────────
   서버 응답 구조:
   {ok, count, results: [{filename, section2, section3}, ...]}
   ═══════════════════════════════════════════════════════════ */
function renderAll(d) {
  const ra          = document.getElementById('resultArea');
  const fileResults = d.results || [{ filename: d.filename || '', section2: d.section2 || {}, section3: d.section3 || [] }];
  let html = '';

  fileResults.forEach((fd, fi) => {
    const fname  = fd.filename || `파일 ${fi + 1}`;
    const s3     = fd.section3 || [];
    const hasErr = !!fd.error;

    /* 파일 제목 구분선 (복수 파일일 때) */
    if (fileResults.length > 1) {
      html += `<div style="margin:${fi > 0 ? '20px' : 0} 0 10px;padding:8px 14px;
                background:var(--pri-dark);color:#fff;border-radius:var(--r);
                font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px">
        📋 ${fi + 1}. ${escHtml(fname)}
        <span style="margin-left:auto;font-size:11px;font-weight:400;opacity:.8">${s3.length}종</span>
      </div>`;
    }

    if (hasErr) {
      html += `<div class="err-box"><strong>⚠️ ${escHtml(fname)} — 오류</strong>${escHtml(fd.error)}</div>`;
      return;
    }

    /* 통합 규제 테이블 */
    html += `<div class="card" style="margin-bottom:${fi < fileResults.length - 1 ? '6px' : '14px'}">
      <div class="card-head">📦 구성성분 + 규제정보
        ${fileResults.length === 1 ? '— ' + escHtml(fname) : ''}
        <span class="sec-badge b-gray" style="margin-left:auto">${s3.length}종</span>
      </div>
      <div class="card-body" style="padding-top:8px">
      <div class="tbl-wrap"><table class="reg">
        <thead>
          <tr>
            <th class="th-info" rowspan="2" style="min-width:130px">화학물질명</th>
            <th class="th-info" rowspan="2">CAS No</th>
            <th class="th-inp"  rowspan="2">최소(%)</th>
            <th class="th-inp"  rowspan="2">최대(%)</th>
            <th class="th-inp"  rowspan="2" title="이하=포함(≤) / 미만=미포함(<)">이하/미만</th>
            <th class="th-kr"   colspan="4">화평법 (K-REACH)</th>
            <th class="th-ko"   colspan="2">산안법 (KOSHA)</th>
          </tr>
          <tr>
            <th class="th-kr" title="유해화학물질 최저 기준함량 / 예외조건">규제함량</th>
            <th class="th-kr" title="유해성 분류 / 기존화학물질 KE번호">유해성 여부</th>
            <th class="th-kr" title="유해화학물질 고시지정일자">고시일자</th>
            <th class="th-kr" title="유해화학물질 고유번호">고유번호</th>
            <th class="th-ko" title="산안법 규제 해당 여부">규제함량</th>
            <th class="th-ko" title="금지물질 / 특별관리대상물질">유해성 여부</th>
          </tr>
        </thead>
        <tbody>`;

    if (!s3.length) {
      html += `<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:24px">
        구성성분 정보가 없습니다.</td></tr>`;
    }

    s3.forEach((comp, ci) => {
      const cas          = comp['cas_no'] || '—';
      const cMin         = comp['함량최소'];
      const cMax         = comp['함량최대'];
      const maxIncluded  = comp['최대포함여부'] !== undefined ? !!comp['최대포함여부'] : !comp['미만여부'];
      const minIncluded  = comp['최소포함여부'] !== undefined ? !!comp['최소포함여부'] : !comp['초과여부'];
      const kr           = comp.kreach || {};
      const ko           = comp.kosha  || {};

      /* 화학물질명 셀 */
      const nmKor = (kr['화학물질명_국문'] || '').trim().replace(/^—$/, '');
      const nmEng = (kr['화학물질명_영문'] || '').trim().replace(/^—$/, '');
      let nmCell;
      if (nmKor)
        nmCell = `<td class="td-nm">${escHtml(nmKor)}${nmEng ? `<br><span style="font-size:10px;color:var(--muted);font-weight:400">(${escHtml(nmEng)})</span>` : ''}</td>`;
      else if (nmEng)
        nmCell = `<td class="td-nm">${escHtml(nmEng)}</td>`;
      else
        nmCell = `<td class="td-nm" style="color:var(--muted);font-style:italic;font-size:11px">미조회<br><span style="font-size:9px">${escHtml(cas)}</span></td>`;

      const minTd = cMin != null ? `<td class="td-num">${cMin}%</td>` : `<td class="cd">—</td>`;
      const maxTd = cMax != null ? `<td class="td-num">${cMax}%</td>` : `<td class="cd">—</td>`;

      /* 이하/미만 플래그 셀 */
      let flagTd;
      if (cMax != null && !maxIncluded)
        flagTd = `<td style="text-align:center;font-size:12px;color:var(--orange);font-weight:700" title="${cMax}% 미포함 (미만 < ${cMax}%)">미만</td>`;
      else if (cMin != null && !minIncluded)
        flagTd = `<td style="text-align:center;font-size:12px;color:var(--orange);font-weight:700" title="${cMin}% 미포함 (초과 > ${cMin}%)">초과</td>`;
      else if (cMax != null)
        flagTd = `<td style="text-align:center;font-size:11px;color:#374151" title="${cMax}% 포함 (이하 ≤ ${cMax}%)">이하</td>`;
      else
        flagTd = `<td class="cd">—</td>`;

      html += `<tr class="${ci > 0 ? 'row-sep' : ''}">
        ${nmCell}
        <td class="td-cas">${escHtml(cas)}</td>
        ${minTd}${maxTd}${flagTd}
        ${buildKrConc(kr, cMax, maxIncluded)}${buildKrHazard(kr)}${buildKrDate(kr)}${buildKrUnqNo(kr)}
        ${buildKoConc(ko)}${buildKoHazard(ko)}
      </tr>`;
    });

    html += `</tbody></table></div></div></div>`;
  });

  /* API 응답 원문 토글 */
  const uid = 'raw-' + Math.random().toString(36).slice(2, 6);
  html += `<div style="text-align:right;margin-top:4px">
    <button class="raw-toggle" onclick="toggleEl('${uid}')">▼ API 응답 원문 보기</button>
    <div id="${uid}" class="raw-box">${escHtml(JSON.stringify(d, null, 2))}</div>
  </div>`;

  ra.innerHTML = html;
  ra.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


/* ═══════════════════════════════════════════════════════════
   9. 유틸리티
   ═══════════════════════════════════════════════════════════ */
function showError(msg) {
  document.getElementById('resultArea').innerHTML = `
    <div class="err-box">
      <strong>⚠️ 오류 발생</strong>
      ${msg}<br><br>
      확인: Flask 서버 실행 여부 · <code>localhost:5000</code> 접근 가능 여부
    </div>`;
}

/* 원문 토글 */
function toggleEl(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === 'block' ? 'none' : 'block';
}

/* HTML 이스케이프 */
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escAttr(s) {
  return (s || '').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

/* ── 페이지 초기화 ──────────────────────────────────────── */
window.addEventListener('load', function () {
  checkServer();
  addMsdsSheet('');   // 기본 시트 1개 생성
});
