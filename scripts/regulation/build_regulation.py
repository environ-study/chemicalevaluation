"""
인체등유해성물질 규제·유예기한 DB 빌드.

입력
  data/regulation/notices.json        부칙 유예기한(사람이 관리)
  data/regulation/sources/*           고시 원문, K-REACH 다운로드 엑셀
출력
  api/_data/regulation.json           서버리스 함수가 읽는 조회용 DB
  data/regulation/regulation-db.xlsx  사람이 검토하는 같은 내용의 엑셀
  data/regulation/BUILD_REPORT.md     건수·제외 내역

규칙
  - 현재 기준(급성·만성·생태 함량): 가장 최근 고시 전체목록.
  - CAS ↔ 고유번호 연결: K-REACH 다운로드 엑셀 + 최신 전체목록의 CAS 열.
    CAS가 없는 항목은 수록하지 않는다(CAS로만 조회).
  - 고시별 유예 대상: notices.json의 targetRule. 고시 간 비교 키는 (일련번호, 소번호).
  - 대상 물질마다 '종전 최저함량(prevMin)'을 남긴다. 유예는 새로 규제 범위에 들어온
    함량(종전 기준 미만)에만 적용되므로, 조회 시 MSDS 함량과 비교한다.
    prevMin이 없으면(신규 지정, 또는 개정 전 값 미확인) 모든 함량에 적용한다.

실행: python3 scripts/regulation/build_regulation.py
"""
import datetime
import hashlib
import json
import os
import sys
from collections import OrderedDict, defaultdict

import openpyxl
from openpyxl.styles import Font, PatternFill

sys.path.insert(0, os.path.dirname(__file__))
import sources as src  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DATA = os.path.join(ROOT, 'data', 'regulation')
SRC = os.path.join(DATA, 'sources')
OUT_JSON = os.path.join(ROOT, 'api', '_data', 'regulation.json')
OUT_XLSX = os.path.join(DATA, 'regulation-db.xlsx')
OUT_REPORT = os.path.join(DATA, 'BUILD_REPORT.md')

KREACH_FILE = 'kreach_20261019_hazard.xlsx'
KREACH_SNAPSHOT = '2026-10-19'


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def key_of(uid, sub):
    return (src.serial(uid), sub)


def load_snapshot(notice):
    path = os.path.join(SRC, notice['source'])
    if notice['source'].endswith('.pdf'):
        snap = src.parse_list_pdf(path)
    else:
        snap = src.parse_list_xlsx(path)
    return OrderedDict((key_of(k[0], k[1]), v) for k, v in snap.items() if not v['deleted'])


def find_targets(notice, snaps, log):
    """→ {(serial, sub|None): {'kind', 'prevMin', 'newMin'}}. sub=None은 그 일련번호 전체."""
    rule = notice['targetRule']
    out = {}
    if rule == 'amendment-doc':
        doc = src.parse_amendment_pdf(os.path.join(SRC, notice['source']))
        for uid in doc['created']:
            out[(src.serial(uid), None)] = {'kind': '신규 지정', 'prevMin': None, 'newMin': None}
        for uid in doc['amended']:
            # 개정 전 별표 미보유 → 함량 변경 여부를 알 수 없어 모두 대상(A안), 범위 제한 없음
            out[(src.serial(uid), None)] = {'kind': '명칭 개정(개정 전 함량 미확인)', 'prevMin': None, 'newMin': None}
        return out

    cur = snaps[notice['id']]
    if rule == 'new-serial-only':
        for k, v in cur.items():
            if k[0] > notice['newSerialAfter']:
                out[k] = {'kind': '신규 지정', 'prevMin': None, 'newMin': v['min']}
        log.append(f"{notice['id']}: 직전 전체목록이 없어 신설 고유번호(일련번호 {notice['newSerialAfter']} 초과)만 대상")
        return out

    if rule == 'prev-column':
        for k, v in cur.items():
            prev = v.get('prev')
            if prev is None:
                out[k] = {'kind': '신규 지정', 'prevMin': None, 'newMin': v['min']}
            elif v['min'] is not None and v['min'] < prev:
                out[k] = {'kind': '함량 하향', 'prevMin': prev, 'newMin': v['min']}
        return out

    if rule == 'list-diff':
        prev = snaps[notice['previous']]
        prev_serials = {k[0] for k in prev}
        for k, v in cur.items():
            if k in prev:
                p = prev[k]
                if v['min'] is None or p['min'] is None:
                    continue
                if v['min'] < p['min'] or (v['main'] is not None and p['main'] is not None and v['main'] < p['main']):
                    bound = p['main'] if v['main'] < p['main'] else p['min']
                    out[k] = {'kind': '함량 하향', 'prevMin': bound, 'newMin': v['min']}
            elif k[0] in prev_serials:
                # 기존 고유번호에 소번호가 새로 생긴 경우: 그 고유번호의 종전 최저함량과 비교
                pm = [p['min'] for pk, p in prev.items() if pk[0] == k[0] and p['min'] is not None]
                pmin = min(pm) if pm else None
                if v['min'] is not None and (pmin is None or v['min'] < pmin):
                    out[k] = {'kind': '함량 하향(소번호 신설)', 'prevMin': pmin, 'newMin': v['min']}
            else:
                out[k] = {'kind': '신규 지정', 'prevMin': None, 'newMin': v['min']}
        return out

    raise ValueError(f"알 수 없는 targetRule: {rule}")


def main():
    cfg = json.load(open(os.path.join(DATA, 'notices.json'), encoding='utf-8'))
    notices = sorted(cfg['notices'], key=lambda n: n['date'])
    log = []

    # 1) 고시별 스냅샷(전체목록이 있는 고시만)
    snaps = {}
    for n in notices:
        if n['targetRule'] != 'amendment-doc':
            snaps[n['id']] = load_snapshot(n)
    latest = [n for n in notices if n['id'] in snaps][-1]
    current = snaps[latest['id']]

    # 2) 고시별 유예 대상
    targets = OrderedDict((n['id'], find_targets(n, snaps, log)) for n in notices)

    # 3) 현재 항목(최신 전체목록) + 각 항목의 대상 고시 이력
    by_serial = defaultdict(list)
    for k in current:
        by_serial[k[0]].append(k)
    entries = OrderedDict()
    for k, v in current.items():
        entries[k] = {
            'uid': v['uid'], 'sub': v['sub'], 'name': v['name'], 'nameEn': v.get('name_en', ''),
            'hazard': v['hazard'], 'cas': list(v['cas']), 'targets': [],
        }
    for nid, tg in targets.items():
        for tk, t in tg.items():
            keys = by_serial.get(tk[0], []) if tk[1] is None else ([tk] if tk in entries else [])
            if not keys:
                log.append(f"{nid}: 대상 일련번호 {tk[0]}(소번호 {tk[1]})가 최신 목록에 없음(삭제 등) → 제외")
            for ek in keys:
                entries[ek]['targets'].append({'notice': nid, **t})

    # 4) CAS 연결: K-REACH 다운로드 + 최신 목록 CAS 열
    cas_links = defaultdict(set)
    unresolved = []
    kreach = src.parse_kreach_xlsx(os.path.join(SRC, KREACH_FILE))
    kreach_ke = {}
    for row in kreach:
        cas = row['cas']
        if not src.CAS_RE.fullmatch(cas or ''):
            continue
        for ln in row['links']:
            s = src.serial(ln['uid'])
            cands = by_serial.get(s, [])
            if (s, ln['sub']) in entries:
                pick = [(s, ln['sub'])]
            else:
                by_cas = [k for k in cands if cas in entries[k]['cas']]
                by_cat = [k for k in cands if sorted(entries[k]['hazard']) == sorted(ln['cats'])]
                pick = by_cas if len(by_cas) == 1 else ([k for k in by_cas if k in by_cat] or by_cat or cands)
                if len(pick) > 1 and by_cas:
                    pick = [k for k in by_cas if k in by_cat] or by_cas
            if not pick:
                unresolved.append((cas, ln['uid'], ln['sub']))
                continue
            for k in pick:
                cas_links[cas].add(k)
    for k, e in entries.items():
        for cas in e['cas']:
            cas_links[cas].add(k)
    if unresolved:
        log.append(f"K-REACH 연결 중 최신 목록에서 찾지 못한 고유번호 {len(unresolved)}건: {unresolved[:10]}")

    # 5) JSON
    def ek(k):
        return f"{k[0]}|{'' if k[1] is None else k[1]}"

    used = {k for ks in cas_links.values() for k in ks}
    out = {
        'meta': {
            'builtAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'kreachSnapshot': KREACH_SNAPSHOT,
            'currentList': latest['id'],
            'scope': '인체등유해성물질(인체급성·인체만성·생태) 지정고시 — 부칙 유예기한',
            'sources': [{'file': f, 'sha256': sha256(os.path.join(SRC, f))} for f in sorted(os.listdir(SRC))],
        },
        'articles': cfg['articles'],
        'notices': OrderedDict((n['id'], {k: v for k, v in n.items() if k not in ('source', 'targetRule', 'previous', 'newSerialAfter')}) for n in notices),
        'entries': OrderedDict((ek(k), {
            'uid': e['uid'], 'sub': e['sub'], 'name': e['name'], 'hazard': e['hazard'],
            'targets': e['targets'],
        }) for k, e in entries.items() if k in used),
        'cas': OrderedDict((c, sorted(ek(k) for k in ks)) for c, ks in sorted(cas_links.items())),
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))

    # 6) 검토용 엑셀
    write_xlsx(cfg, notices, targets, snaps, entries, cas_links, log)

    # 7) 리포트
    n_target = {nid: len(t) for nid, t in targets.items()}
    with open(OUT_REPORT, 'w', encoding='utf-8') as f:
        f.write('# 규제 DB 빌드 리포트\n\n')
        f.write(f"- 빌드 시각(UTC): {out['meta']['builtAt']}\n")
        f.write(f"- 현재 기준 목록: 제{latest['id']}호 / K-REACH 다운로드 {KREACH_SNAPSHOT}\n")
        f.write(f"- 수록 CAS: {len(out['cas'])}개 / 고유번호·소번호 항목: {len(out['entries'])}개\n\n")
        f.write('## 고시별 유예 대상 수(고유번호·소번호 단위)\n\n| 고시 | 대상 규칙 | 대상 수 |\n|---|---|---|\n')
        for n in notices:
            f.write(f"| {n['id']} | {n['targetRule']} | {n_target[n['id']]} |\n")
        f.write('\n## 처리 로그\n\n')
        for line in log:
            f.write(f'- {line}\n')
    print(f"OK: {OUT_JSON} ({os.path.getsize(OUT_JSON)//1024} KB), CAS {len(out['cas'])}, entries {len(out['entries'])}")
    for nid, c in n_target.items():
        print(f'  {nid}: {c}')
    for line in log:
        print('  -', line[:200])


def write_xlsx(cfg, notices, targets, snaps, entries, cas_links, log):
    wb = openpyxl.Workbook()
    bold = Font(bold=True)
    fill = PatternFill('solid', fgColor='DDEBF7')

    def sheet(title, header, rows):
        ws = wb.create_sheet(title)
        ws.append(header)
        for c in ws[1]:
            c.font = bold
            c.fill = fill
        for r in rows:
            ws.append(r)
        ws.freeze_panes = 'A2'
        for col in ws.columns:
            width = max(len(str(c.value or '')) for c in col[:200])
            ws.column_dimensions[col[0].column_letter].width = min(max(8, width * 1.2), 60)
        return ws

    wb.remove(wb.active)
    arts = cfg['articles']
    rows = []
    for n in notices:
        groups = [('일반', n)] + [(s['label'], s) for s in n.get('specials', [])]
        for label, g in groups:
            for a, task in arts.items():
                rows.append([n['id'], n['date'], label, f'제{a}조', task, g['deadlines'][a], n['dueRule'],
                             g.get('effectiveDate', n['effectiveDate']), g.get('holder', n['holder'])])
    sheet('부칙 기한', ['고시', '고시일', '적용 구분', '조문', '준수사항', '기한', '기한 표현', '시행일(대상 물질)', '대상 취급자'], rows)

    names = {}
    for k, e in entries.items():
        names[k] = e['name']
    rows = []
    for nid, tg in targets.items():
        for (s, sub), t in tg.items():
            uids = sorted({entries[k]['uid'] for k in entries if k[0] == s}) or ['(최신 목록에 없음)']
            name = next((entries[k]['name'] for k in entries if k[0] == s and (sub is None or k[1] == sub)), '')
            rows.append([nid, uids[0], sub, name, t['kind'], t['prevMin'], t['newMin']])
    sheet('고시별 대상', ['고시', '고유번호(현재)', '소번호', '물질명', '구분', '종전 최저(%)', '변경 후 최저(%)'], rows)

    rows = []
    for k, e in entries.items():
        last = max(e['targets'], key=lambda t: cfg_date(notices, t['notice'])) if e['targets'] else None
        rows.append([e['uid'], e['sub'], e['name'], e['hazard'].get('급성'), e['hazard'].get('만성'), e['hazard'].get('생태'),
                     ', '.join(e['cas']), last['notice'] if last else None, last['kind'] if last else None,
                     last['prevMin'] if last else None])
    sheet('현재 기준', ['고유번호', '소번호', '물질명', '급성(%)', '만성(%)', '생태(%)', '고시 기재 CAS', '최신 유예 고시', '구분', '종전 최저(%)'], rows)

    rows = []
    for cas, ks in sorted(cas_links.items()):
        for k in sorted(ks, key=lambda x: (x[0], x[1] or 0)):
            e = entries[k]
            rows.append([cas, e['uid'], e['sub'], e['name'], e['hazard'].get('급성'), e['hazard'].get('만성'), e['hazard'].get('생태')])
    sheet('CAS 연결', ['CAS', '고유번호', '소번호', '물질명', '급성(%)', '만성(%)', '생태(%)'], rows)

    sheet('빌드 로그', ['내용'], [[line] for line in log])
    wb.save(OUT_XLSX)


def cfg_date(notices, nid):
    return next(n['date'] for n in notices if n['id'] == nid)


if __name__ == '__main__':
    main()
