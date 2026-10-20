"""
빌드된 규제 DB(api/_data/regulation.json)를 K-REACH 실시간 API와 CAS별로 대조한다.

비교 항목(인체등유해성물질만)
  - 연결된 고유번호(일련번호) 집합
  - 급성·만성·생태 구분별 최저 함량기준

실행:
  KREACH_API_KEY=... python3 scripts/regulation/verify_against_api.py [--cache 경로]
결과: data/regulation/API_VERIFY.md (+ 응답 캐시 JSON)
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DB = os.path.join(ROOT, 'api', '_data', 'regulation.json')
REPORT = os.path.join(ROOT, 'data', 'regulation', 'API_VERIFY.md')
URL = 'https://apis.data.go.kr/B552584/kecoapi/ncissbstn/chemSbstnList'
HZ = [(re.compile(r'인체\s*급성'), '급성'), (re.compile(r'인체\s*만성'), '만성'), (re.compile(r'생태'), '생태')]


def fetch(cas, key):
    q = urllib.parse.urlencode({'serviceKey': key, 'pageNo': 1, 'numOfRows': 10,
                                'searchGubun': 2, 'searchNm': cas, 'returnType': 'JSON'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(f'{URL}?{q}', timeout=20) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:  # noqa: BLE001 — 재시도 후 기록
            err = str(e)
            time.sleep(1.5 * (attempt + 1))
    return {'_error': err}


def api_view(cas, body):
    items = (body.get('body') or {}).get('items') or []
    if isinstance(items, dict):
        items = [items]
    items = [it for it in items if not it.get('casNo') or it.get('casNo', '').strip() == cas] or items
    serials, hazard = set(), {}
    for it in items:
        tl = it.get('typeList') or []
        if isinstance(tl, dict):
            tl = [tl]
        for t in tl:
            if '인체등유해성물질' not in (t.get('sbstnClsfTypeNm') or ''):
                continue
            m = re.match(r'\s*\d{2,4}-\d-(\d{1,4})', t.get('unqNo') or '')
            if m:
                serials.add(int(m.group(1)))
            for seg in re.split(r',\s*(?=[가-힣])', t.get('contInfo') or ''):
                v = re.search(r':\s*(\d+(?:\.\d+)?)\s*%', seg)
                if not v:
                    continue
                for pat, cat in HZ:
                    if pat.search(seg):
                        hazard[cat] = min(float(v.group(1)), hazard.get(cat, 1e9))
                        break
    return {'found': bool(items), 'serials': serials, 'hazard': hazard}


def db_view(db, cas):
    serials, hazard = set(), {}
    for k in db['cas'][cas]:
        e = db['entries'][k]
        serials.add(int(k.split('|')[0]))
        for cat, v in e['hazard'].items():
            hazard[cat] = min(v, hazard.get(cat, 1e9))
    return {'serials': serials, 'hazard': hazard}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(ROOT, 'data', 'regulation', '.api_cache.json'))
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()
    key = os.environ.get('KREACH_API_KEY')
    if not key:
        sys.exit('KREACH_API_KEY 환경변수가 필요합니다.')

    db = json.load(open(DB, encoding='utf-8'))
    cache = json.load(open(args.cache, encoding='utf-8')) if os.path.exists(args.cache) else {}
    todo = [c for c in db['cas'] if c not in cache or '_error' in cache[c]]
    print(f'CAS {len(db["cas"])}개 중 조회 필요 {len(todo)}개')
    with cf.ThreadPoolExecutor(args.workers) as ex:
        for i, (cas, body) in enumerate(zip(todo, ex.map(lambda c: fetch(c, key), todo)), 1):
            cache[cas] = body
            if i % 200 == 0:
                print(f'  {i}/{len(todo)}')
                json.dump(cache, open(args.cache, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(cache, open(args.cache, 'w', encoding='utf-8'), ensure_ascii=False)

    res = {'일치': [], '조회 오류': [], 'API 미등록': [], 'API에 인체등유해성 없음': [],
           '함량기준 다름': [], '고유번호만 다름': []}
    for cas in db['cas']:
        body = cache.get(cas, {})
        if '_error' in body or (body.get('header') or {}).get('resultCode') not in ('200', '00', None):
            res['조회 오류'].append((cas, body.get('_error') or body.get('header')))
            continue
        a, d = api_view(cas, body), db_view(db, cas)
        if not a['found']:
            res['API 미등록'].append((cas,))
        elif not a['serials'] and not a['hazard']:
            res['API에 인체등유해성 없음'].append((cas, sorted(d['serials'])))
        elif a['hazard'] != d['hazard']:
            res['함량기준 다름'].append((cas, d['hazard'], a['hazard'], sorted(d['serials']), sorted(a['serials'])))
        elif a['serials'] != d['serials']:
            res['고유번호만 다름'].append((cas, sorted(d['serials']), sorted(a['serials'])))
        else:
            res['일치'].append((cas,))

    with open(REPORT, 'w', encoding='utf-8') as f:
        f.write(f'# 규제 DB ↔ K-REACH 실시간 API 대조\n\n- 대조 시각: {time.strftime("%Y-%m-%d %H:%M")}\n'
                f'- DB 빌드: {db["meta"]["builtAt"]} (현재 목록 제{db["meta"]["currentList"]}호)\n\n')
        f.write('| 결과 | CAS 수 |\n|---|---|\n')
        for k, v in res.items():
            f.write(f'| {k} | {len(v)} |\n')
        for k, v in res.items():
            if k == '일치' or not v:
                continue
            f.write(f'\n## {k}\n\n')
            for row in v:
                f.write(f'- {row}\n')
    for k, v in res.items():
        print(f'{k}: {len(v)}')
    print('→', REPORT)


if __name__ == '__main__':
    main()
