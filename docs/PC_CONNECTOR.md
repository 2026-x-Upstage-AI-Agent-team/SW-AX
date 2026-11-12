# 담당자 PC 연결

서비스 주소: <https://d3nkw8bzgv8pom.cloudfront.net>

각 담당자는 자기 Windows PC에 설치된 한글로 자기 계정의 서류를 변환하고 PDF를 출력한다. 개발자 PC를 켜둘 필요는 없다. AWS의 기존 t3.medium은 API·접수 준비·Studio 판정·HWPX 생성·출력 검증을 맡으며 DB 구성과 사양은 유지한다.

## 처음 사용하는 PC

1. 한글을 설치하고 정상적으로 문서를 열 수 있는 Windows PC에서 서비스 계정으로 로그인한다.
2. 왼쪽 메뉴의 **내 PC 연결**을 연다. 바로가기: <https://d3nkw8bzgv8pom.cloudfront.net/#/pc-connect>
3. **PC 연결 프로그램 다운로드**로 받은 `SWAX-PC-Setup.exe`를 실행하고 설치 안내를 확인한다.
4. 웹으로 돌아와 **이 PC 연결**을 누른다. 브라우저의 프로그램 열기 확인창을 허용한다.
5. 연결 프로그램이 보여주는 서비스 계정이 본인 계정인지 확인하고 연결한다.
6. 웹에 **PC 연결됨**과 초록색 표시등이 보이면 대회를 만들고 원본을 올린다. 새 대회 ID를 별도로 등록하지 않는다. 연결이 끊기거나 한글 준비가 확인되지 않으면 표시등은 회색이다.

설치 파일은 64비트 Windows용이며 Windows 11에서 확인했다. Python과 변환에 필요한 라이브러리를 포함하므로 담당자는 Python, PowerShell 7, AWS CLI, IAM 계정, DB 비밀번호를 준비하지 않는다. PC에 설치된 한글과 Windows 기본 PowerShell을 사용한다. 현재 시연용 설치 파일은 코드 서명 인증서가 없는 EXE이므로 조직의 Windows 실행 정책에 따라 실행 승인이 필요할 수 있다.

### Chrome 다운로드·Windows SmartScreen 경고

현재 EXE의 Authenticode 상태는 `NotSigned`다. Chrome의 ‘일반적으로 다운로드되지 않음’은 Google Safe Browsing이 해당 파일을 충분히 확인하지 못했을 때 표시할 수 있다. Google의 평가로 해제될 수 있고, Search Console의 보안 문제 보고서에 해당 문제가 있으면 검토를 요청할 수 있다. [Google 안내](https://support.google.com/webmasters/answer/9044101?hl=en)

SmartScreen은 발행자와 파일의 평판을 확인한다. 정식 코드 서명으로 발행자를 표시하고 같은 발행자 신원으로 릴리스를 관리하면 신뢰도를 쌓는 데 도움이 되지만, 새 파일은 서명 후에도 경고가 남을 수 있다. EV 인증서도 즉시 경고 제거를 보장하지 않는다. 장기 배포에서는 Microsoft Store용 패키징·심사를 검토할 수 있다. 현재 EXE에 코드 서명을 추가하거나 Store에 등록한 상태는 아니다. [Microsoft 안내](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

웹의 PC 연결 표시 변경으로 브라우저나 Windows의 보안 경고를 제거할 수는 없다. 학교·기관의 실행 정책과 배포 출처 확인 절차를 따른다.

## 설치한 다음부터

- 같은 Windows 사용자로 로그인하면 연결 프로그램이 자동으로 시작한다. 브라우저를 닫아도 연결 프로그램은 실행된다.
- PC 전원·Windows 로그인·인터넷 연결·한글 실행 가능 상태를 유지한다. 절전이나 종료 중에는 그 담당자의 변환·출력이 기다리고, 다시 연결되면 이어진다.
- 일시적인 인터넷/API 장애는 자동으로 재접속한다. 프로그램 자체가 종료되면 같은 사용자 작업의 1분 간격 트리거가 다시 실행한다. 실행 중인 작업은 중복 시작하지 않는다. 중단된 문서 작업의 임대가 만료되면 다시 배정하며, 동시에 같은 파일을 두 PC에 배정하지 않는다.
- 이미 등록한 PC에는 반복 설치 알림을 표시하지 않는다. 꺼져 있으면 **연결 프로그램 실행·재연결**을 안내한다. 복구용 다운로드 안내는 접힌 도움말에 있다.
- 브라우저 저장소를 지우거나 새 브라우저·새 서비스 계정을 사용하면 **이 PC 연결**을 다시 누른다. 프로그램을 재설치할 필요는 없다. 다운로드만 했을 때는 설치 완료로 표시하지 않는다.
- PC 한 대의 Windows 사용자에는 서비스 계정 하나를 연결한다. 다른 서비스 계정을 연결하면 이후 작업은 새 계정 기준이다. 공동 PC에서는 계정과 연결 상태를 확인한다.

개발자 PC를 끈 상태에서도 다른 담당자는 자기 PC를 연결해 사용할 수 있다. 변환할 담당자의 PC까지 모두 꺼져 있으면 해당 계정의 한글 변환·PDF 출력은 대기한다. 웹/API와 이미 만들어진 결과물 조회·다운로드는 AWS에서 제공한다.

팀별 검토용 PDF가 준비되면 AWS가 각 팀을 별도 Studio 작업으로 실행한다. 한 팀씩 업로드해도 앞 팀의 판정 완료를 기다리지 않고 다음 팀의 판정을 시작한다. 연결 프로그램 **1.1.0부터 같은 PC에서 최대 두 작업을 동시에 처리**한다. 원본 두 개, 원본과 보고서, 보고서 두 개를 각각 별도 한글 프로세스로 처리하며 세 번째 작업부터는 자리가 날 때까지 기다린다. Studio의 요청 제한이 발생하면 안내된 대기 시간 후 재시도한다.

기존 1.0.0 사용자는 웹에서 최신 설치 파일을 내려받아 한 번 업데이트해야 PC 병렬 처리가 적용된다. 기존 계정 연결은 유지되며 AWS 로그인은 필요 없다. 최신 버전을 설치한 PC에 반복 설치를 요구하지 않는다.

## 작업 범위와 보관

- 원본은 업로드한 계정, 보고서는 생성을 요청한 계정의 PC에 배정한다. 해당 대회의 담당자 접근 권한도 계속 확인한다.
- PC는 한 번에 하나씩 변환한다. 원본 해시와 작업 임대를 확인하고, 원본 판독 정보·PDF만 서버로 보낸다. 판정은 기존 Upstage Studio Agent와 Config 5가 수행한다.
- 웹의 연결 해제는 장치 인증을 즉시 무효화한다. 재사용하려면 웹에서 다시 연결한다.
- 연결 인증은 서버에 해시로, PC에는 현재 Windows 사용자 DPAPI로 암호화해 보관한다. 사람의 AWS 세션 만료와 무관하다.
- PC 작업 파일은 사용자 로컬 폴더의 임시 작업 디렉터리에 생성되며 완료 후 정리한다. 중단 잔여물은 다음 시작 때 프로그램이 생성한 파일만 정리한다. 서버 원본은 기존 접수 보관 규칙을 따른다.

## 연결 문제 확인

| 웹 표시 | 확인할 일 |
|---|---|
| PC 연결 필요 | 설치한 프로그램이 있으면 이 PC 연결을 누른다. 처음인 PC만 설치한다. |
| 연결 프로그램 실행 필요 | 같은 Windows 사용자로 로그인했는지 확인하고 실행·재연결을 누른다. |
| 한글 설치·실행 확인 필요 | 한글을 직접 열어 초기 설정·정품 인증·문서 열기가 가능한지 확인한다. 연결 프로그램은 실제 빈 PDF 출력으로 사용 가능 여부를 검사한다. |
| PC 연결 상태 확인 실패 | 서비스 로그인과 인터넷 연결을 확인하고 연결 확인을 누른다. |
| 원본 판독 실패 | 원본을 열 수 있는지 확인한 뒤 기존 파일 판독 재시도 기능을 사용한다. |

사용자별 설치 위치는 `%LOCALAPPDATA%\SWAX\PCConnector`, 실행 파일은 `1.1.0\SWAX-PC.exe`다. 작업 스케줄러의 `SWAX-PC-Connector-<사용자 식별값>` 하나에 로그인 자동 실행과 1분 간격 복구 트리거를 등록한다. [Microsoft의 작업 트리거 설명](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger?view=windowsserver2025-ps)에 따라 둘 중 하나가 발생하면 실행하며, `IgnoreNew`와 파일 잠금으로 중복 처리를 막는다. 연결 해제 후 제거하려면 해당 작업과 사용자 프로토콜 등록 및 설치 폴더를 제거한다. `connection.bin`은 암호화된 인증 파일이므로 공유하거나 다른 PC에 복사하지 않는다.

## 개발·배포 검증

주요 소스는 `pc_connector/`, `PcDevices.java`, `PcTasks.java`, `PcAgentController.java`, `PcAgentAccess.java`, `V6__pc_connectors.sql`, `V7__pc_parallel_slots.sql`, `operations/processes.py`, `frontend/src/pages/PcConnect.tsx`다. 설치 패키지는 개발 PC의 자격증명을 포함하지 않는다. `/api/pc-agent/claim`의 선택 본문 `{"slot":0}` 또는 `{"slot":1}`로 작업별 배정과 복구를 구분하며, 본문 없는 구버전 요청은 슬롯 0으로 처리한다.

```powershell
# 연결 프로그램 단위 검증
.\.venv\Scripts\python.exe -m unittest tests.test_pc_connector

# 프런트엔드 및 Windows 설치 패키지
cd frontend
npm run build
node --test tests/pc-connection.mjs
cd ..
# 빌드 전용 Python 3.12 환경: 서비스 자격증명은 넣지 않는다.
.\.venv\Scripts\python.exe -m venv var/pc-connector-build/tools
.\var\pc-connector-build\tools\Scripts\python.exe -m pip install -r pc_connector/requirements-build.txt
.\var\pc-connector-build\tools\Scripts\python.exe -m pc_connector.build
.\var\pc-connector-build\tools\Scripts\python.exe scripts/audit_pc_installer.py

# 한글 경로에서 Gradle 시험 워커가 클래스를 못 찾는 환경은 ASCII 임시 사본 사용
.\.venv\Scripts\python.exe scripts/build_pc_backend.py

# 별도 로컬 시험 DB에서 장치·계정 범위·임대·재시도·동시성·다운로드 검증
.\.venv\Scripts\python.exe scripts/verify_pc_connector.py --jar <검증할-JAR> --port 18886

# 설치된 한글로 출력 일치·시간 초과·부모 종료·기존 문서 보존 검증
.\.venv\Scripts\python.exe tests/verify_pc_parallel_native.py --guard-dir "$env:LOCALAPPDATA/SWAX/PCConnector/hancom"
```

실제 AWS 적용 기록은 `var/pc-connector-deployment/`에, 가상 set01의 실제 연결 검증 결과는 그 아래 `e2e/result.json`에 보관한다. `scripts/verify_pc_connector_cloud.py --pair-only`는 설치 파일·장치 등록을 확인하고, 이어서 옵션 없이 실행하면 승인받은 가상 set01로 실제 문서 흐름을 확인한다. 시연 계정 비밀번호는 실행 시 직접 입력하며 결과 파일에 저장하지 않는다. 실제 메일 발송이나 지급은 실행하지 않는다.

`scripts/verify_pc_connector_recovery.py`는 위 검증을 마친 유휴 장치에서만 실행한다. 공개 설치 파일 해시를 확인하고 해당 장치의 워커 자식 프로세스 하나를 강제 종료한 뒤 자동 복구와 동일한 장치 인증 유지를 확인한다. 실제 PC 재부팅을 수행하는 시험은 아니다.

배포는 기존 실행 JAR에서 이 기능에 필요한 클래스·리소스만 교체하고 나머지는 보존했다. `deploy/pc-connector/apply.ps1`은 기존 JAR·워커·설정의 해시 확인과 백업 후 전환한다. `update-api.ps1`은 전환 이후의 단일 JAR 보완용이며 이전 해시가 다르면 중단한다. 같은 패치를 검토 없이 재실행하지 않는다. 신규 원격 준비 워커 `SWAX-prepare`를 포함해 AWS의 기존 작업 스케줄러를 사용한다.

개발자 PC의 옛 공용 prepare·printer와 `SWAX-d1110a-PC-Recovery`는 새 방식으로 전환하면서 중지·비활성화했고, 기존 SSM DB 터널도 종료했다. PC용 AWS 인증서를 일반 사용자에게 배포하지 않는다. 서버의 공용 출력 워커 토큰 경로는 담당자별 PC 모드에서 차단한다.

11월 12일 가상 set01의 원본 3개를 새 대회에 접수해 Studio Config 5의 성공 판정 → HWPX 4개 구역 → 원본 증빙 검증 → 최종 PDF 6쪽의 확정·다운로드를 확인했다. 원본 다운로드 3개의 SHA-256도 일치했고 최종 PDF 전 페이지를 렌더링해 확인했다. 장치·계정 분리 등 HTTP 계약 40개, Python 10개, JUnit 18개와 Chrome PC 안내 시험 4개가 통과했다. 실제 물리 PC는 현재 PC 한 대에서 시험했으며, 다른 계정·두 PC의 배정 범위와 동시성은 별도 DB의 API 시험으로 검증했다.

기존 화면 전체 회귀 시험에서는 18개 중 17개가 통과했다. 수정 HWPX 미리보기 1개는 이전 배포 JAR의 정적 파일에서도 같은 실패가 재현돼 이번 연결 작업과 별도로 남겼다. Gmail의 기존 Google 콜백 설정 문제도 이번 작업의 해결 범위에 포함하지 않았다.

1.1.0 병렬 전환은 `deploy/pc-parallel/apply.ps1`로 기존 t3.medium에 적용했다. HTTP 계약 57개와 Python 시험 14개, 실제 한글 세 조합의 동시 출력·단독 출력과의 페이지별 픽셀 일치, 서로 다른 두 보고서의 동시 출력 3회, 시간 초과·부모 종료 격리와 기존 문서 보존을 확인했다. 검증 중 발견한 PDF 누락은 PDF 파일 완료 확인과 공유 인쇄 보조 프로세스를 포함하지 않는 종료 범위로 보강했다. 이 PC의 기존 연결을 유지해 1.1.0으로 업데이트한 뒤 공개 주소에서도 원본 3개와 6쪽 최종 PDF·서버 증빙 검증·자동 복구가 통과했다. 검증 범위는 현재 Windows PC이며 근거는 `var/pc-parallel-deployment/`와 `var/pc-parallel-native/`에 있다.
