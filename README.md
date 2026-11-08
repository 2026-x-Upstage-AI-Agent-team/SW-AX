# SW-AX

유잇 팀의 SW중심대학 사업단 시상금 증빙 자동화 프로젝트입니다. 사업단 담당자가 접수한 신청서·동의서·대표 증빙을 팀별로 대조하고, 확인된 정보로 지급내역서와 증빙을 담은 한글 보고서 및 PDF를 작성하는 과정을 다룹니다.

운영판의 첫 단계로 **React · Spring Boot · PostgreSQL** 기반의 원본 접수 화면을 구현했습니다. 대회·팀을 등록하고 여러 팀의 한글 원본을 한 번에 접수한 뒤 접수번호로 다시 열거나 원본을 내려받을 수 있습니다. Windows 시연판은 HTML·CSS·JavaScript, FastAPI, SQLite로 구성되어 있으며, 공식 두 팀의 Studio 검토부터 HWPX·PDF 다운로드까지 검증했습니다. 운영판 워커는 별도 세션에서 구현 중입니다.

## 운영판 원본 접수 실행

Windows에서 Docker Desktop, JDK 21, Node.js 22.12 이상(또는 24 LTS), PowerShell 7.2 이상을 준비하고 프로젝트 루트에서 실행합니다.

```powershell
./start-intake.ps1
```

전용 PostgreSQL 컨테이너가 준비되면 Spring Boot가 접수 화면과 API를 제공합니다. 아래 절차로 만든 담당자 계정으로 로그인해 **대회·팀 관리 → 대회 등록**에서 대회를 만듭니다. **원본 접수**에서 올린 서류는 **접수 내역**에서 다시 받을 수 있습니다. [담당자 로그인](http://127.0.0.1:18765/login)

API는 이 PC의 루프백 주소에 바인딩합니다. PostgreSQL은 로컬 포트 `55432`와 Compose 볼륨 `swax-intake_intake_data`를 사용합니다. 기본 개발 DB 비밀번호는 첫 실행 때 `var/intake-postgres.key`에 생성합니다. 다른 DB를 사용할 때는 `AWARDS_DB_URL`, `AWARDS_DB_USER`, `AWARDS_DB_PASSWORD`를 같은 환경에 설정합니다. `./start-service.ps1`은 Windows 시연판 실행 명령입니다.

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
