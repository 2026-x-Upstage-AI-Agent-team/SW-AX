# 담당자 화면 (frontend)

React 19 · Vite · TypeScript · Tailwind CSS v4 · React Router.
담당자 화면 리디자인 시안의 에메랄드·민트 색상을 `src/index.css`의 `@theme`에 모아 두었다.

시작 화면에서 **시상금 서류 검토** 카테고리를 선택하고, 대회별 워크스페이스를 만들거나 연다. 업무 현황의 **한 팀의 서류 올리기**에서 시작한다. 서류를 올리면 해당 묶음의 **검토 진행 보기**가 표시되고, 검토가 끝나면 **팀별 결과 확인**으로 이어진다. 사이드바와 휴대폰 메뉴의 **워크스페이스 목록**에서 다른 작업 공간을 열 수 있다. 확정한 보고서의 HWPX·PDF 다운로드는 미리보기 위에 함께 표시한다. 키보드 포커스, 동작 줄이기, 투명도 줄이기, 고대비 설정을 지원한다. [적용한 Apple 디자인 지침](https://github.com/emilkowalski/skills/tree/main/skills/apple-design)

새 워크스페이스의 **시작 가이드**는 **서류 올리기 → 검토 진행 → 팀별 결과 확인 → 지급 보고서** 순서로 실제 버튼을 강조한다. 첫 단계에서 **파일 선택**과 **선택한 서류 올리기**를 안내한다. 모바일에서는 메뉴 열기부터 안내한다. **이전**, **다음 안내**, **다음 단계**, **가이드 종료**를 제공하며, 종료·진행 상태를 워크스페이스별로 기억한다. 선택한 서류는 가이드를 종료하거나 다시 시작해도 유지된다. 오른쪽 아래 **도움말 → 시작 가이드**에서 다시 시작할 수 있다. **개발자에게 문의하기**는 공개 GitHub Issues를 새 탭으로 연다.

A 그린 1 로고, 흰색 사이드바, 진한 남색 메뉴 선택 표시, 상단 검색·계정 메뉴와 둥근 버튼을 사용한다. 공통 리디자인 스타일은 `src/staff-redesign.css`에 둔다. 사이드바와 모바일 메뉴에 네 단계의 **업무 순서**와 **팀장 안내 메일** 바로가기를 표시한다. 업무 현황의 AI 판정 분포는 원형 차트로 표시한다.

**업무 현황**은 확인할 일·AI 판정 분포·단계별 현황을 보여준다. **팀별 결과 확인**에서는 팀명이나 대표자로 검색하거나 업무 단계로 필터하고, 원문을 대조한 뒤 승인하거나 보완 필요를 기록한다. 보완이 필요한 팀은 **안내 메일 검토**에서 해당 팀의 수신자와 초안을 확인할 수 있다. 상세에서 돌아오면 검색 조건과 선택 팀의 위치가 복원된다. 검색 버튼이나 Ctrl/Cmd+K로 현재 공간의 팀·파일·메뉴를 찾고, 파일 조회 실패 시 다시 시도할 수 있다.

**서류 올리기**, **검토 진행**, **팀 배정 확인** 탭은 `IntakeLayout`의 동일한 폭과 여백을 공유한다.

`/#/`는 업무 카테고리, `/#/categories/awards/workspaces`는 워크스페이스 목록·생성 화면이다. 내부 화면은 `/#/categories/awards/workspaces/{워크스페이스 ID}` 아래에 있다. 주소에 있는 ID로 대회를 선택하므로 새로고침과 여러 탭에서 작업 공간이 유지된다. 존재하지 않거나 권한이 없는 작업 공간은 다른 대회로 자동 전환하지 않는다. 기존 `/#/intake`, `/#/gmail` 등은 마지막 작업 공간의 새 주소로 연결한다.

로그인을 마치면 이전 화면 주소와 관계없이 `/#/`의 업무 카테고리 선택 화면으로 이동한다. 로그인 폼과 서버 리디렉션 모두 이 주소를 명시하므로 실패 후 재시도하거나 로그인 스크립트가 실행되지 않아도 이전 작업 공간으로 바로 진입하지 않는다.

운영 DB의 `work_category`와 `award_event.category_id`가 카테고리와 작업 공간을 연결한다. 현재 `awards`만 `enabled=true`이며 기존 대회에도 자동 적용한다. 결과보고서·사업비 집행 증빙·장학금 서류·참여/활동 증빙·협약/계약 서류 검토는 `enabled=false`인 회색 ‘준비 중’ 카드다. 링크와 키보드 진입을 제공하지 않고, 직접 주소에서는 준비 중 안내를 표시하며 서버도 워크스페이스 생성을 거부한다. 표시 순서는 `sort_order`를 사용한다. 카테고리를 활성화할 때는 해당 업무의 검토 화면·워크플로우를 함께 구현해야 한다.

팀 배정은 작업 공간이 넓으면 목록과 원본을 나란히 보여준다. 좁은 화면에서는 파일을 열어 검토하고 ‘파일 목록으로’ 또는 브라우저 뒤로가기로 선택한 행에 돌아온다. 조회 실패는 같은 화면에서 다시 시도하고, 배정 입력 오류와 업로드 파일 오류는 해당 입력란에서 확인한다. [적용한 UI UX Pro Max 지침](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/4f2dbb67e64969a9a30ab00742f2d55d66ddec2b/.claude/skills/ui-ux-pro-max/references/quick-reference.md)

## 워커 상태와 문서 미리보기

왼쪽 사이드바 하단에서 **워커 실행 필요 → 실행하기**를 누른다. 휴대폰에서는 작업 메뉴를 열면 같은 버튼이 보인다. 시작 요청은 로그인한 담당자가 보낼 수 있다. 서버가 업무 워커의 PostgreSQL 연결과 같은 PC에 둔 PDF 워커의 응답을 확인하면 **워커 실행 중**으로 바뀐다. 상태는 15초마다 갱신되고, 조회에 실패하면 **다시 확인**할 수 있다. 전용 출력 PC를 분리한 구성에서는 사이드바가 업무 서버의 워커를 제어하고 전용 PC는 예약 작업으로 PDF 워커를 실행한다.

팀 배정 화면은 넓은 화면의 남는 폭을 문서 미리보기에 사용한다. **크게 보기**를 누르면 창 전체에 가깝게 문서를 볼 수 있다. **닫기** 또는 Esc로 돌아오면 선택한 파일과 입력 중인 배정 근거가 유지된다.

## 실행

```powershell
npm install
npm run dev           # 접수 API(Spring Boot, 127.0.0.1:18765)에 연결
npm run dev:service   # 검토 서비스(Windows 시연판 FastAPI, 127.0.0.1:8765)에 연결
npm run build         # 타입 검사 후 dist/ 생성 (backend gradle 빌드가 static/ 으로 복사)
npm run test:ux       # 빌드한 화면의 배정·접수 흐름을 Chrome과 시험용 로컬 API로 확인
npm run test:navigation # 검색·사이드바·검토 목록·후속 작업을 시험용 API로 확인
npm run test:workspaces # INTAKE_TEST_URL과 시험 계정으로 로그인·워크스페이스 흐름 확인
npm run test:editor   # 별도 시험 서버에서 공식 가상 HWP·HWPX를 직접 편집하고 새 버전을 다시 연다
```

두 모드 모두 http://127.0.0.1:5173 에서 열고, `/api` 요청은 Vite가 해당 서버로 넘긴다.
Spring Boot가 `dist/`를 정적 파일로 내보내므로 해시 라우팅(`/#/teams/...`)을 쓴다.

팀 배정 확인과 팀별 검토의 **한글 문서 편집**은 같은 서버의 `/rhwp/`에서 Studio, WASM, 글꼴을 읽는다. 최초 개발 실행·빌드는 지정된 rhwp 0.9.0 배포본을 받아 SHA-256을 검증한다. 이후에는 `var/rhwp-editor-build/rhwp-chrome-0.9.0.zip`을 재사용하며, 배포된 시연 웹은 이 다운로드 없이 편집한다. `test:editor`는 `INTAKE_TEST_URL`, `INTAKE_TEST_LOGIN_A`, `INTAKE_TEST_PASSWORD_A`를 지정한 로컬 시험 서버에 가상 접수를 생성한다. [rhwp 배포본](https://github.com/edwardkim/rhwp/releases/tag/v0.9.0)

| 모드 | 백엔드 | 실제로 동작하는 화면 |
|---|---|---|
| `dev` | Spring Boot 접수 API (`backend/`) | 업무 현황, 원본·보완본 접수, 팀 배정·버전·판정 근거, 원문 PDF, 담당자 결론·지급값, 메일·Gmail, 보고서 생성·확정·편집본·다운로드 |
| `dev:service` | 검토 서비스 (`service/app.py`, `start-service.ps1`) | 전부. 원본 접수(보완본 포함), Studio 판정 현황, 팀 배정, 담당자 검토·결론 기록, 팀장 이메일, 메일 본문·재시도, Gmail 연결, 보고서 생성·확정·HWPX/PDF 다운로드·편집본 업로드 |

검토 서비스는 상태를 바꾸는 요청에 `X-Award-Client: staff` 헤더와 같은 출처를 요구한다. 클라이언트는 헤더를 항상 붙이고, `dev:service` 프록시는 `Origin`을 검토 서비스 주소로 맞춰 보낸다.

### 담당자 Gmail 연결

사이드바나 모바일 메뉴에서 **Gmail 연결**을 연다. **이메일 발송 → Gmail 연결**로도 들어갈 수 있다. 검토 서비스 모드에서는 등록된 발신 주소와 인증 상태를 확인하고 Google 로그인 또는 16자리 앱 비밀번호로 연결한다. Google 로그인에는 웹 클라이언트 JSON을 사용한다. [계정 준비 방법](../docs/IMPLEMENTATION_PLAN.md#51-담당자-gmail-연결)

Spring Boot 접수 모드에서는 [18765의 Gmail 연결](http://127.0.0.1:18765/#/gmail)에서 **내 발신 계정**을 확인한다. 발신 주소를 서버에 미리 등록하지 않아도 **Google 계정 연결**로 본인 계정을 선택할 수 있다. 연결 후에도 **다른 Google 계정으로 변경**과 **연결 해제**를 표시한다. 변경을 취소하거나 인증에 실패하면 기존 연결을 유지한다. 앱 비밀번호 방식은 본인의 Google 이메일과 16자리 코드를 입력한다. 연결 정보는 로그인한 담당자별로 저장되며 다른 담당자의 계정을 조회·변경·해제하지 않는다. 메일은 발송을 승인한 담당자의 계정으로 보내고, 발신 주소가 변경된 대기 메일은 초안으로 돌아가 다시 승인받는다. Google 클라이언트는 서버에서 읽으며 두 방법 모두 8765 실행이 필요 없다. `VITE_REVIEW_SERVICE_URL`은 `dev:service`에서 별도 검토 서비스에 연결할 때만 사용한다.

`npm run build` 후 `node --test tests/gmail-accounts.mjs`를 실행하면 연결 전 계정 선택, 기존 계정 변경, 인증 실패 보존, Google·앱 비밀번호 연결 해제와 320px 화면을 검증한다. Google 인증과 API 응답은 대역으로 처리하며 실제 계정 연결·메일 발송은 하지 않는다.

## 화면과 API

아래 화면 경로는 워크스페이스 주소 뒤에 붙는다. 한글 편집기 `/files/{id}/edit`와 문서 미리보기는 독립 화면이며, 편집기에는 돌아갈 워크스페이스 정보를 함께 전달한다. API의 기존 경로와 제출 버전은 유지한다.

| 경로 | 화면 | 검토 서비스 API |
|---|---|---|
| `/` · `/home` | 카테고리 선택. 로그인 직후 열리며 업무별 워크스페이스 목록으로 들어간다. | `GET /api/auth/session`, `GET /api/categories` |
| `/categories/:categoryId/workspaces` | 카테고리별 워크스페이스 생성·선택 | `GET·POST /api/events` |
| `/categories/awards/workspaces/:workspaceId` | 업무 현황과 시작 가이드. 아래의 작업 경로는 이 주소 뒤에 붙는다. | `GET /api/dashboard`, `GET /api/submissions/{id}` |
| `/teams/:id` | 팀별 서류 검토 (원본 PDF, Upstage 판정·필드 설명, 검토 항목, 담당자 결론, 명단, 버전 기록) | `GET·PUT /api/submissions/{id}[/review]`, `POST .../retry`, `GET /api/files/{id}/preview` |
| `/review` | 팀별 결과 확인 (작업 단계·검색·정렬·후속 작업) | `GET /api/dashboard`, `GET /api/submissions/{id}` |
| `/intake` · `/intake?base=:id` | 서류 올리기 · 보완 서류 올리기. 화면 어디에나 파일을 끌어다 놓을 수 있다. | `POST /api/intake-batches` (`base`, `removed`) |
| `/intake/batches[/:id]` | 검토 진행 목록 · 묶음 상세 | `GET /api/intake-batches/{id}` |
| `/assign` | 팀 배정 확인 (배정·보류·대상 외, 판독 재시도) | `PUT .../files/{id}/assignment`, `POST .../files/{id}/retry` |
| `/mail` | 메일 목록과 초안 검토(제목·본문 수정, 승인 후 발송), 발송 이력, 팀장 수신 주소 확인·입력 | `PUT /api/teams/{id}/email`, `GET /api/mail/{id}`, `PUT /api/mail/{id}/draft`, `POST /api/mail/{id}/approve`, `POST /api/mail/{id}/retry` |
| `/gmail` | 내 Gmail 연결·계정 변경·연결 해제 | Spring Boot 상태 `GET /api/settings/gmail`, 해제 `POST /api/settings/gmail/disconnect`(기존 `/oauth/disconnect`도 허용). Google 시작 `POST /api/settings/gmail/oauth/start`, 복귀 `GET /api/settings/gmail/callback`, 앱 비밀번호 `POST /api/settings/gmail/connect`(`address`, `app_password`) |
| `/report` | 보고서 확정 (팀 순서, 지급 정보 입력, 두 표 미리보기, 생성·확정·다운로드) | `GET /api/events/{id}/draft`, `POST /api/reports`, `GET·POST /api/reports/{id}[/confirm|/edited|/preview|/hwpx|/pdf]` |
| `/manage` | 현재 워크스페이스 설정, 지급내역서 행사 정보, 삭제 | `PUT /api/events/{id}/overview`, `DELETE /api/events/{id}` |

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

`INTAKE_TEST_URL`, `INTAKE_TEST_LOGIN_A`, `INTAKE_TEST_PASSWORD_A`를 로컬 시험 서버에 맞춰 지정하고 `npm run test:workspaces`를 실행하면 카테고리 선택·생성·파일 첨부 진입·새로고침·다중 탭·320px 화면·없는 작업 공간을 검증한다. 이 시험은 빈 워크스페이스 두 개만 생성하며 종료할 때 해당 두 개를 삭제한다. Studio 호출과 메일 발송은 하지 않는다.
