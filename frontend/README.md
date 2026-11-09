# 담당자 화면 (frontend)

React 19 · Vite · TypeScript · Tailwind CSS v4 · React Router.
색상은 울산대학교 SW중심대학사업단 사이트(sw.ulsan.ac.kr) 팔레트를 `src/index.css`의 `@theme`에 모아 두었다.

넓은 화면에서는 사이드바에서 대회를 선택하고, 휴대폰에서는 상단 메뉴에서 대회를 바꾼다. 업무 현황에서 판정 분포와 확인할 일을 먼저 보고 팀별 근거를 열 수 있다. 확정한 보고서의 HWPX·PDF 다운로드는 미리보기 위에 함께 표시한다. 키보드 포커스, 동작 줄이기, 투명도 줄이기, 고대비 설정을 지원한다. [적용한 Apple 디자인 지침](https://github.com/emilkowalski/skills/tree/main/skills/apple-design)

팀 배정은 작업 공간이 넓으면 목록과 원본을 나란히 보여준다. 좁은 화면에서는 파일을 열어 검토하고 ‘파일 목록으로’ 또는 브라우저 뒤로가기로 선택한 행에 돌아온다. 조회 실패는 같은 화면에서 다시 시도하고, 배정 입력 오류와 업로드 파일 오류는 해당 입력란에서 확인한다. [적용한 UI UX Pro Max 지침](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/4f2dbb67e64969a9a30ab00742f2d55d66ddec2b/.claude/skills/ui-ux-pro-max/references/quick-reference.md)

## 실행

```powershell
npm install
npm run dev           # 접수 API(Spring Boot, 127.0.0.1:18765)에 연결
npm run dev:service   # 검토 서비스(Windows 시연판 FastAPI, 127.0.0.1:8765)에 연결
npm run build         # 타입 검사 후 dist/ 생성 (backend gradle 빌드가 static/ 으로 복사)
npm run test:ux       # 빌드한 화면의 배정·접수 흐름을 Chrome과 시험용 로컬 API로 확인
```

두 모드 모두 http://127.0.0.1:5173 에서 열고, `/api` 요청은 Vite가 해당 서버로 넘긴다.
Spring Boot가 `dist/`를 정적 파일로 내보내므로 해시 라우팅(`/#/teams/...`)을 쓴다.

| 모드 | 백엔드 | 실제로 동작하는 화면 |
|---|---|---|
| `dev` | Spring Boot 접수 API (`backend/`) | 업무 현황, 원본·보완본 접수, 팀 배정·버전·판정 근거, 원문 PDF, 담당자 결론·지급값, 메일·Gmail, 보고서 생성·확정·편집본·다운로드 |
| `dev:service` | 검토 서비스 (`service/app.py`, `start-service.ps1`) | 전부. 원본 접수(보완본 포함), Studio 판정 현황, 팀 배정, 담당자 검토·결론 기록, 팀장 이메일, 메일 본문·재시도, Gmail 연결, 보고서 생성·확정·HWPX/PDF 다운로드·편집본 업로드 |

검토 서비스는 상태를 바꾸는 요청에 `X-Award-Client: staff` 헤더와 같은 출처를 요구한다. 클라이언트는 헤더를 항상 붙이고, `dev:service` 프록시는 `Origin`을 검토 서비스 주소로 맞춰 보낸다.

### 담당자 Gmail 연결

사이드바나 모바일 메뉴에서 **Gmail 연결**을 연다. **발송 이력 → Gmail 연결**로도 들어갈 수 있다. 검토 서비스 모드에서는 등록된 발신 주소와 인증 상태를 확인하고 Google 로그인 또는 16자리 앱 비밀번호로 연결한다. Google 로그인에는 웹 클라이언트 JSON을 사용한다. [계정 준비 방법](../docs/IMPLEMENTATION_PLAN.md#51-담당자-gmail-연결)

Spring Boot 접수 모드에서는 [18765의 Gmail 연결](http://127.0.0.1:18765/#/gmail)에서 계정 상태를 확인한다. **Google로 연결**은 같은 탭에서 Google 승인을 열고 완료·취소 후 이 화면으로 돌아온다. Google 계정이 연결되면 버튼이 **연결 해제**로 바뀐다. 해제가 완료되면 새 Gmail 발송은 대기하고 같은 버튼으로 다시 연결할 수 있다. Google 클라이언트는 서버에서 읽으며, 앱 비밀번호 설정도 18765에서 처리한다. 두 방법 모두 8765 실행이 필요 없다. `VITE_REVIEW_SERVICE_URL`은 `dev:service`에서 별도 검토 서비스에 연결할 때만 사용한다.

## 화면과 API

| 경로 | 화면 | 검토 서비스 API |
|---|---|---|
| `/` | 업무 현황 (판정 요약, 확인할 일, 팀별 판정 표) | `GET /api/dashboard`, `GET /api/submissions/{id}` |
| `/teams/:id` | 팀별 서류 검토 (원본 PDF, 검토 항목, 담당자 결론, 팀장 안내, 명단, 버전 기록) | `GET·PUT /api/submissions/{id}[/review]`, `POST .../retry`, `PUT /api/teams/{id}/email`, `GET /api/files/{id}/preview` |
| `/intake` · `/intake?base=:id` | 원본 접수 · 보완본 접수 | `POST /api/intake-batches` (`base`, `removed`) |
| `/intake/batches[/:id]` | 접수 내역 · 접수 상세 | `GET /api/intake-batches/{id}` |
| `/assign` | 팀 배정 확인 (배정·보류·대상 외, 판독 재시도) | `PUT .../files/{id}/assignment`, `POST .../files/{id}/retry` |
| `/mail` | 발송 이력 (팀장 안내·담당자 알림, 본문, 재시도, Gmail 연결, 팀장 이메일 입력) | `GET·POST /api/mail/{id}[/retry]`, `POST /api/settings/gmail/...` |
| `/gmail` | 담당자 Gmail 연결·해제·재인증 | Spring Boot 상태 `GET /api/settings/gmail`, Google 연결 해제 `POST /api/settings/gmail/oauth/disconnect`. 양쪽 서비스 `POST /api/settings/gmail/oauth/start`, `GET /api/settings/gmail/callback`, `POST /api/settings/gmail/connect` |
| `/report` | 보고서 확정 (팀 순서, 지급 정보 입력, 두 표 미리보기, 생성·확정·다운로드) | `GET /api/events/{id}/draft`, `POST /api/reports`, `GET·POST /api/reports/{id}[/confirm|/edited|/preview|/hwpx|/pdf]` |
| `/manage` | 대회·팀 관리 | `POST /api/events`, `POST /api/events/{id}/teams` |

판독·판정·문서 생성·메일 발송이 진행 중이면 현황을 몇 초마다 다시 읽는다.

Spring Boot 접수 상세의 **팀별 판정 작업**은 대기 또는 처리 중인 팀이 있으면 3초마다 갱신한다. 완료한 팀에는 검토 완료와 최종판정이 함께 표시되고, 기술 오류로 끝난 팀에는 처리 실패가 표시된다. [판정 작업 API](../docs/IMPLEMENTATION_PLAN.md#워커-판정-작업-배정과-결과-등록)

## 폴더

```
src/
  api/backend.ts    어느 백엔드에 붙었는지 (VITE_API_TARGET)
  api/client.ts     fetch 래퍼, 오류 문구, useApi·useAsync·usePolling
  api/intake.ts     접수·대회·팀 API (두 백엔드 공통 경로)
  api/service.ts    검토·보완·메일·보고서 API 타입과 호출
  api/labels.ts     상태·서류·보완 항목 표기 (service/static/common.js와 같음)
  context/          선택한 대회, 팀 목록, 검토 서비스 현황
  hooks/            현황판 팀 목록
  components/       Layout, 배지·버튼·PDF 미리보기·메일 항목 등 공용 UI
  pages/            화면
```

운영판은 로그인 세션에 배정된 대회의 PostgreSQL 데이터로 화면을 구성한다. 접수·제출본의 운영 상세 정보는 `/api/operations/batches/{id}`와 `/api/operations/submissions/{id}`에서 읽는다.
