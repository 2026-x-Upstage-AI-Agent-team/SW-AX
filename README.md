# SW-AX

유잇 팀의 SW중심대학 사업단 시상금 증빙 자동화 프로젝트입니다. 사업단 담당자가 접수한 신청서·동의서·대표 증빙을 팀별로 대조하고, 확인된 정보로 지급내역서와 증빙을 담은 한글 보고서 및 PDF를 작성하는 과정을 다룹니다.

운영판은 **React · Spring Boot · PostgreSQL**을 사용합니다. 담당자가 혼합 원본을 접수하면 워커가 파일별 검토 PDF와 팀 배정 근거를 준비합니다. 담당자는 Studio 판정과 원본을 대조하고 보완본·메일·지급 정보를 같은 제출 이력에서 관리합니다. 확정한 팀의 증빙은 편집 가능한 HWPX로 편철한 뒤 Windows 한글에서 같은 버전의 PDF로 출력합니다.

## 운영판 원본 접수 실행

Windows에서 Docker Desktop, JDK 21, Node.js 22.12 이상(또는 24 LTS), PowerShell 7.2 이상, Python 3.12 이상과 한글을 준비하고 프로젝트 루트에서 실행합니다.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r operations/requirements.txt
./start-intake.ps1
```

전용 PostgreSQL 컨테이너가 준비되면 Spring Boot가 접수 화면과 API를 제공합니다. 아래 절차로 만든 담당자 계정으로 로그인해 **대회·팀 관리 → 대회 등록**에서 대회를 만듭니다. **원본 접수**에서 올린 서류는 **접수 내역**에서 다시 받을 수 있습니다. [담당자 로그인](http://127.0.0.1:18765/login)

API는 이 PC의 루프백 주소에 바인딩합니다. PostgreSQL은 로컬 포트 `55432`와 Compose 볼륨 `swax-intake_intake_data`를 사용합니다. 기본 개발 DB 비밀번호는 첫 실행 때 `var/intake-postgres.key`에 생성합니다. 다른 DB를 사용할 때는 `AWARDS_DB_URL`, `AWARDS_DB_USER`, `AWARDS_DB_PASSWORD`를 같은 환경에 설정합니다. `./start-service.ps1`은 Windows 시연판 실행 명령입니다.

### 판정, 메일과 보고서 출력

Studio 실행에는 서버의 환경 변수 또는 프로젝트의 `.env.local`에 `UPSTAGE_API_KEY`, `UPSTAGE_AGENT_ID`, `UPSTAGE_CONFIG_ID`를 설정합니다. 공식 시험에는 설정 버전 23을 사용합니다. `MAIL_MODE=local`은 로컬 수신함을 사용합니다. 실제 발송은 `#/gmail`에서 담당자 계정을 연결하고 검토 화면에서 팀별 수신 주소를 확인해 저장합니다.

단일 PC에서는 `start-intake.ps1`이 접수 서버, 문서 판독·판정·메일·편철 워커와 PDF 워커를 실행합니다. 00 지급내역서 원본을 팀 자료 폴더에 두거나 `AWARDS_REPORT_TEMPLATE`에 경로를 지정합니다. 처음 실행할 때 한글 경로 확인 모듈을 빌드하고 현재 Windows 사용자에 등록합니다. 이 모듈은 변환 작업별 폴더의 입력 한글 파일과 출력 PDF 경로를 검사합니다.

출력 PC를 따로 두려면 서버는 `./start-intake.ps1 -RemotePrinter`로 실행합니다. 전용 Windows PC에 한글, 같은 코드와 가상환경을 준비하고 `./start-output-printer.ps1 -Prepare`에서 서버의 HTTPS 주소와 출력 전용 토큰을 입력합니다. 서버 토큰은 환경 변수 `AWARDS_OUTPUT_WORKER_TOKEN` 또는 첫 실행 때 생성한 `var/output-worker.key`에 있습니다. `./start-output-printer.ps1`이 작업을 받습니다. 전용 계정으로 부팅 시 시작하도록 등록하는 명령은 `./start-output-printer.ps1 -InstallAtStartup`입니다. 출력 PC의 토큰은 그 Windows 계정으로 암호화합니다. 원격 접속에는 Spring Boot 앞에 HTTPS 리버스 프록시를 두거나 서버에 HTTPS를 설정하고, 출력 PC가 신뢰하는 인증서를 사용합니다. 원본의 검토용 PDF를 만드는 처리 호스트에도 한글이 필요합니다. [운영판 API와 인수 시험](docs/IMPLEMENTATION_PLAN.md)

### 담당자 계정과 대회 권한

서비스를 한 번 시작해 DB 마이그레이션을 적용한 뒤, 운영자가 프로젝트 루트의 PowerShell에서 계정을 만듭니다. 비밀번호는 숨김 입력으로 받고 DB에는 bcrypt 해시를 저장합니다. 새 대회는 생성한 계정에 배정합니다. 기존 대회와 공동 담당자는 운영자가 대회 ID로 지정합니다.

```powershell
./manage-staff.ps1 -Action create -Login staff01
./manage-staff.ps1 -Action events
$eventId = Read-Host '배정할 대회 UUID'
./manage-staff.ps1 -Action grant -Login staff01 -EventId $eventId
```

권한 회수는 같은 인자에 `-Action revoke`를 사용합니다. 이미 로그인한 담당자의 다음 요청에도 반영됩니다. 로그인은 `/login`, 로그아웃은 `/logout`이며 세션은 30분 미사용 시 만료됩니다. [인증 API와 권한 범위](docs/IMPLEMENTATION_PLAN.md#담당자-인증과-대회-권한)

접수 API 회귀 시험은 공식 ZIP과 `httpx`를 사용합니다. 별도 테스트 DB에 두 계정을 만든 뒤 로컬 API 주소를 `INTAKE_TEST_URL`에, 계정과 비밀번호를 `INTAKE_TEST_LOGIN_A`, `INTAKE_TEST_PASSWORD_A`, `INTAKE_TEST_LOGIN_B`, `INTAKE_TEST_PASSWORD_B`에 설정합니다. 시험은 그 DB에 대회와 테스트 접수를 생성합니다.

수동 배정·확정 API 회귀 시험은 판독 완료 상태를 준비하기 위해 같은 로컬 시험 DB의 `AWARDS_DB_URL`, `AWARDS_DB_USER`, `AWARDS_DB_PASSWORD`를 사용합니다. 실제 한글 원본의 판독 전후는 `tests.test_operations_cases`에서 검증합니다. 해당 시험 후 같은 서버와 시험 계정으로 `npm --prefix frontend run test:review`를 실행하면 설치된 Chrome에서 근거 원문과 누락 파일 목록 이동을 검사합니다.

판정 워커를 연결하려면 Spring Boot와 워커에 같은 `AWARDS_REVIEW_WORKER_TOKEN`을 설정합니다. 워커는 확정 원본을 배정받고 결과를 제출하며, 담당자는 접수 상세에서 팀별 진행 상태와 최종판정을 확인합니다. 회귀 시험 환경에도 같은 토큰을 설정하면 동시 배정 시험을 실행합니다. 만료 후 인계까지 검증할 때는 **시험 서버**에 `AWARDS_REVIEW_LEASE_SECONDS=15`, 시험 클라이언트에 `INTAKE_TEST_SHORT_LEASE=1`을 설정합니다. [워커 API 명세](docs/IMPLEMENTATION_PLAN.md#워커-판정-작업-배정과-결과-등록)

```powershell
python -m unittest discover -s tests -p test_intake_postgres.py -v
```

## 프로젝트 문서

| 문서 | 내용 |
|---|---|
| [프로젝트 기획서](PROJECT_PLAN.md) | 학교 담당자 인터뷰에서 확인한 업무, 팀별 판정 기준, 보고서 양식, 시연 범위와 검증 결과 |
| [서비스 구현계획서](docs/IMPLEMENTATION_PLAN.md) | React·Spring Boot 전환 범위, 파일 접수·팀 배정, 오류 복구와 인수 기준 |
| [Windows 시연판 실행 안내](docs/LOCAL_SERVICE.md) | 팀 작업 폴더에서 현재 시연판을 실행하고 검토·편철 결과를 확인하는 절차 |
| [Studio 구성 프롬프트](docs/STUDIO_BUILD_PROMPT.txt) | 문서 분류·추출·대조와 결과 출력을 위한 워크플로우 구성안 |
| [미션 2 유형표](docs/유잇_미션2_유형표.xlsx) | set01~set10의 시험 목적과 기대 결과 |
| [미션 2 정답 JSON](output/json/유잇_미션2_answer.json) | 팀별 기대 판정과 그 근거 |
| [프로젝트 작업 안내](AGENTS.md) | 프로젝트를 이어받을 때 확인할 자료와 작업 기준 |

기획서에서 언급하는 학생 제출 양식과 테스트 입력, API 실행 원문은 팀 작업 폴더에서 관리합니다. 공개 기획서의 가상 계좌번호와 생년월일 예시는 마스킹했습니다.
