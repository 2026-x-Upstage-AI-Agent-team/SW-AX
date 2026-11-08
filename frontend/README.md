# 담당자 화면 (frontend)

React 19 · Vite · TypeScript · Tailwind CSS v4 · React Router.
색상은 울산대학교 SW중심대학사업단 사이트(sw.ulsan.ac.kr) 팔레트를 `src/index.css`의 `@theme`에 모아 두었다.

## 실행

```powershell
npm install
npm run dev           # 접수 API(Spring Boot, 127.0.0.1:18765)에 연결
npm run dev:service   # 검토 서비스(Windows 시연판 FastAPI, 127.0.0.1:8765)에 연결
npm run build         # 타입 검사 후 dist/ 생성 (backend gradle 빌드가 static/ 으로 복사)
```

두 모드 모두 http://127.0.0.1:5173 에서 열고, `/api` 요청은 Vite가 해당 서버로 넘긴다.
Spring Boot가 `dist/`를 정적 파일로 내보내므로 해시 라우팅(`/#/teams/...`)을 쓴다.

| 모드 | 백엔드 | 실제로 동작하는 화면 |
|---|---|---|
| `dev` | Spring Boot 접수 API (`backend/`) | 원본 접수, 접수 내역·상세·원본 받기, 대회·팀 관리. 판정·검토 화면은 예시 데이터 |
| `dev:service` | 검토 서비스 (`service/app.py`, `start-service.ps1`) | 전부. 원본 접수(보완본 포함), Studio 판정 현황, 팀 배정, 담당자 검토·결론 기록, 팀장 이메일, 메일 본문·재시도, Gmail 연결, 보고서 생성·확정·HWPX/PDF 다운로드·편집본 업로드 |

검토 서비스는 상태를 바꾸는 요청에 `X-Award-Client: staff` 헤더와 같은 출처를 요구한다. 클라이언트는 헤더를 항상 붙이고, `dev:service` 프록시는 `Origin` 헤더를 떼어 보낸다.

## 화면과 API

| 경로 | 화면 | 검토 서비스 API |
|---|---|---|
| `/` | 업무 현황 (판정 요약, 확인할 일, 팀별 판정 표) | `GET /api/dashboard`, `GET /api/submissions/{id}` |
| `/teams/:id` | 팀별 서류 검토 (원본 PDF, 검토 항목, 담당자 결론, 팀장 안내, 명단, 버전 기록) | `GET·PUT /api/submissions/{id}[/review]`, `POST .../retry`, `PUT /api/teams/{id}/email`, `GET /api/files/{id}/preview` |
| `/intake` · `/intake?base=:id` | 원본 접수 · 보완본 접수 | `POST /api/intake-batches` (`base`, `removed`) |
| `/intake/batches[/:id]` | 접수 내역 · 접수 상세 | `GET /api/intake-batches/{id}` |
| `/assign` | 팀 배정 확인 (배정·보류·대상 외, 판독 재시도) | `PUT .../files/{id}/assignment`, `POST .../files/{id}/retry` |
| `/mail` | 발송 이력 (팀장 안내·담당자 알림, 본문, 재시도, Gmail 연결, 팀장 이메일 입력) | `GET·POST /api/mail/{id}[/retry]`, `POST /api/settings/gmail/...` |
| `/report` | 보고서 확정 (팀 순서, 지급 정보 입력, 두 표 미리보기, 생성·확정·다운로드) | `GET /api/events/{id}/draft`, `POST /api/reports`, `GET·POST /api/reports/{id}[/confirm|/edited|/preview|/hwpx|/pdf]` |
| `/manage` | 대회·팀 관리 | `POST /api/events`, `POST /api/events/{id}/teams` |

판독·판정·문서 생성·메일 발송이 진행 중이면 현황을 몇 초마다 다시 읽는다.

## 폴더

```
src/
  api/backend.ts    어느 백엔드에 붙었는지 (VITE_API_TARGET)
  api/client.ts     fetch 래퍼, 오류 문구, useApi·useAsync·usePolling
  api/intake.ts     접수·대회·팀 API (두 백엔드 공통 경로)
  api/service.ts    검토 서비스 API 타입과 호출. 연결 전에는 mocks/service.ts를 돌려준다
  api/labels.ts     상태·서류·보완 항목 표기 (service/static/common.js와 같음)
  mocks/service.ts  set01–set10 예시 데이터 (output/json/유잇_미션2_answer.json 기준, 응답 형태는 service/app.py와 같음)
  context/          선택한 대회, 팀 목록, 검토 서비스 현황
  hooks/            현황판 팀 목록
  components/       Layout, 배지·버튼·PDF 미리보기·메일 항목 등 공용 UI
  pages/            화면
```

예시 데이터 화면에는 제목 옆에 "예시 데이터" 표시가 붙고 저장 버튼이 막힌다. 예시 데이터에는 학생 이름·학번·계좌를 넣지 않는다.
Spring Boot에 판정·검토 API가 생기면 `api/service.ts`의 경로만 맞추면 같은 화면을 그대로 쓸 수 있다.
