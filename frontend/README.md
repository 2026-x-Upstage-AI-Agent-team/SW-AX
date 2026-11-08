# 담당자 화면 (frontend)

React 19 · Vite · TypeScript · Tailwind CSS v4 · React Router.
색상은 울산대학교 SW중심대학사업단 사이트(sw.ulsan.ac.kr) 팔레트를 `src/index.css`의 `@theme`에 모아 두었다.

## 실행

```powershell
npm install
npm run dev        # http://127.0.0.1:5173, /api 는 Spring Boot(127.0.0.1:18765)로 프록시
npm run build      # 타입 검사 후 dist/ 생성 (backend gradle 빌드가 static/ 으로 복사)
```

Spring Boot가 `dist/`를 정적 파일로 내보내므로 해시 라우팅(`/#/teams/set03`)을 쓴다.

## 화면과 데이터 출처

| 경로 | 화면 | 데이터 |
|---|---|---|
| `/` | 업무 현황 (판정 요약, 팀별 판정 표) | mock |
| `/teams/:id` | 팀별 서류 검토 (원문 미리보기, 체크리스트, 팀장 메일) | mock |
| `/intake`, `/intake/batches`, `/intake/batches/:id` | 원본 접수, 접수 내역, 접수 상세 | **실제 API** |
| `/assign` | 팀 배정 확인 | mock |
| `/mail` | 발송 이력 (팀장 안내, 담당자 알림) | mock |
| `/report` | 보고서 확정 (팀 순서, 금액 입력, 편철 미리보기) | mock |
| `/manage` | 대회·팀 관리 | **실제 API** |

## 폴더

```
src/
  api/client.ts     fetch 래퍼, useApi·useAsync 훅
  api/intake.ts     접수 API (Spring Boot) — 실제 호출
  api/review.ts     판정·배정·발송·보고서 API — 지금은 mocks를 반환
  mocks/review.ts   set01–set10 예시 데이터 (output/json/유잇_미션2_answer.json 기준)
  context/          선택한 대회·팀 목록
  components/       Layout, 배지·버튼 등 공용 UI
  pages/            화면
```

판정·발송·보고서 API가 생기면 `api/review.ts`의 함수 본문만 `api()`/`postJson()` 호출로 바꾸면 된다.
mock 화면에는 제목 옆에 "예시 데이터" 표시가 붙는다. 학생 이름·학번·계좌 등은 넣지 않고 `○○○`, `[학번]` 같은 자리 표시로 둔다.
