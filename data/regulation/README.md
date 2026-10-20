# 인체등유해성물질 규제·유예기한 DB

K-REACH 실시간 API를 보완하는 지정고시 DB입니다. `/api/kreach` 응답에 다음을 더합니다.

- **고시 기준 보완**: API에 아직 없거나 API보다 엄격한 인체급성·인체만성·생태 기준을 지정고시 별표 기준으로 추가합니다. 시행 전 고시의 기준은 `matchedPending`(시행 예정)으로만 표시하고 현재 판정에서는 뺍니다.
- **묶음 CAS 재조회**: K-REACH는 CAS가 묶여 등록된 물질(예: 이미다클로프리드 `105827-78-9, 138261-41-3`)을 단일 CAS로 찾지 못하므로 묶음 문자열로 다시 조회합니다.
- **부칙 유예기한**(`grace`): 최신 유예 고시의 제16·13·28·23·24조 기한 중 1일 이상 남은 것을 보여줍니다. 그 고시로 새로 규제 범위에 들어온 함량(종전 기준 미만)에만 적용합니다.

기존/신규화학물질 판정은 K-REACH API 결과(KE번호)만 따릅니다.

## 구성

| 파일 | 내용 |
|---|---|
| `sources/` | 고시 원문(별표·개정문·전문), K-REACH 다운로드 엑셀 |
| `notices.json` | 고시별 부칙 기한 — **사람이 관리하는 유일한 입력** |
| `../../scripts/regulation/build_regulation.py` | 원문 → `api/_data/regulation.json` + `regulation-db.xlsx` |
| `../../scripts/regulation/verify_against_api.py` | 빌드 결과를 K-REACH API와 CAS별 대조 → `API_VERIFY.md` |
| `BUILD_REPORT.md` | 고시별 유예 대상 수와 처리 로그 |

## 새 고시가 나왔을 때

1. 별표 전체목록 xlsx(가능하면 개정사항 xlsx도)를 `sources/notice_<번호>_list.xlsx`로 넣습니다.
2. `notices.json`에 항목을 하나 추가합니다: 고시일, 시행일, 부칙의 5개 조문 기한, `targetRule: "list-diff"`, `previous: <직전 고시>`. 특례(특정 물질 별도 유예)가 있으면 `specials`에 넣습니다.
3. K-REACH 화학물질정보처리시스템에서 급성·만성·생태 목록을 다시 내려받아 `sources/kreach_<날짜>_hazard.xlsx`로 넣고, `build_regulation.py`의 `KREACH_FILE`·`KREACH_SNAPSHOT`을 바꿉니다.
4. 빌드와 대조를 실행합니다.

```bash
pip install pdfplumber openpyxl
python3 scripts/regulation/build_regulation.py
KREACH_API_KEY=... python3 scripts/regulation/verify_against_api.py
```

5. `BUILD_REPORT.md`와 `API_VERIFY.md`를 확인하고 커밋하면 Vercel 배포로 반영됩니다.

## 판정 규칙(요약)

- 고시 간 비교 키는 고유번호의 일련번호(마지막 숫자)와 소번호입니다. 연도 부분은 재고시 때 바뀔 수 있습니다(2023-1-1174 → 2024-1-1174).
- 2022-63·2022-80: 개정문의 신설 고유번호만 유예 대상입니다(B안). 명칭 개정 항목은 개정 전 별표가 없어 함량 변경 여부를 알 수 없으므로 제외합니다. 개정 전 별표를 구하면 `notices.json`의 `amendedItems`로 조정할 수 있습니다.
- 2023-21: 직전 전체목록이 없어 신설 고유번호만 대상입니다.
- 2025-19: 별표의 `(종전) 유독물질 함량` 열과 비교합니다.
- 그 외: 직전 전체목록과 비교해 신규 고유번호·소번호 또는 함량 하향을 대상으로 봅니다.
