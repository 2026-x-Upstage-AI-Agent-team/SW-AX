# PC 워커의 사람 로그인 의존 제거

기존 t3.medium과 API·DB·네트워크를 유지하고 IAM Roles Anywhere의 PC 인증서로 임시 AWS 자격증명을 발급받는다. 새 리소스는 IAM 역할, 외부 공개 CA 인증서의 trust anchor, Roles Anywhere profile 세 개다. 유료 AWS Private CA·장기 IAM 액세스 키·추가 EC2를 만들지 않는다.

현재 사용자의 Windows `CurrentUser\My` 저장소에서 내보낼 수 없는 RSA 키를 사용한다. 공개 CA와 공개 인증서만 작업 폴더로 내보낸다. Windows의 신뢰할 수 있는 루트 인증서 저장소는 변경하지 않는다. 인증서 유효기간은 365일이며 만료 전 인증서 갱신은 필요하다. 이 기간 동안 AWS 사람 로그인 12시간 제한에 의존하지 않는다.

## 준비와 관리자 등록

원래 PC에서 `prepare-pc.ps1`과 `provision.py`를 실행하면 `var/aws-pc-auth-d1110a/`에 공개 등록 자료가 준비된다. `provision.py`의 기본 동작은 파일 생성이며, `--execute`를 붙이면 계정 416775509196·서울 리전에 전용 CloudFormation 스택 `swax-demo-d1110a-pc-auth`를 배포한다. 기존 앱 스택은 변경하지 않는다. 같은 이름의 스택이 다른 device tag를 갖고 있으면 중단한다.

`swax-pc-russe`의 CloudFormation 조회 권한 부족으로 관리자 등록이 필요했다. 관리자가 전용 스택을 등록하고 전달한 ARN으로 2026-11-11 원래 PC의 전환을 완료했다. 관리자 콘솔 절차는 `var/aws-pc-auth-d1110a/ADMIN_CONSOLE_REQUEST.txt`에 있다. 관리자에게 개인키·인증서 파일 PFX·AWS 액세스 키를 전달하지 않는다. 등록을 다시 할 필요는 없다.

리소스 생성에 필요한 CloudFormation·IAM role·Roles Anywhere 권한이 있는 관리자 프로필을 사용한다. 실행 전 같은 폴더의 `pc-auth.template.json`을 검토할 수 있다. 역할 권한은 기존 EC2 한 대를 통한 관리형 문서의 SSM 포트 전달, 지정된 DB·review·output 비밀값 세 개 조회뿐이다. 신뢰 정책은 계정·trust anchor ARN·인증서 subject CN·issuer CN을 고정한다. 관리형 문서의 허용 범위는 기존 PC 연결과 같다. IAM 관리·SSM 셸·Run Command·다른 비밀 조회를 부여하지 않는다.

## PC 전환

관리자가 생성한 `cloud-result.json`(ARN 세 개가 담긴 공개 출력)을 원래 PC로 전달한 후 실행한다.

```powershell
.\scripts\aws_pc_auth\finish-pc.ps1 -CloudResult <cloud-result.json의_경로>
```

이 명령은 별도의 AWS config와 비어 있는 credentials 파일, 사용하지 않는 사람 로그인 캐시 경로를 사용해 전용 인증서를 검증한다. STS가 사람 IAM 사용자 대신 지정된 assumed role을 반환하고 워커 비밀값 세 개를 읽을 수 있어야 한다. 키 원문은 출력·저장하지 않는다. 그 후 별도 15435 포트에서 실제 터널 복구를 시험하고 감시 작업만 다시 시작한다. 기존 prepare·printer는 중복 실행하지 않는다. 인증·터널 시험이 실패하면 전환 마커를 되돌린다.

원래 `.aws/config`와 사람용 `swax-d1110a` 프로필은 수정하지 않는다. 장치 인증이 활성화된 후 인증서에 오류가 나면 사람 로그인으로 몰래 대체하지 않는다.

한국어 Windows의 AWS 도구는 프로필을 시스템 문자 인코딩으로 읽는다. 한글 경로가 있는 프로필은 이 PC의 CP949로 저장하며, 이전 UTF-8·CRLF 설정은 같은 내용임을 확인한 뒤 변환한다. 설정 파일 인코딩은 `ready.json`의 `config_encoding`에 기록한다.

## 검증 상태

2026-11-11 19:21 KST 전환을 완료했다. 사람 로그인 캐시를 사용하지 않는 별도 AWS config·빈 credentials 파일에서 전용 assumed role의 STS 인증과 워커 비밀값 세 개 조회가 성공했다. 별도 15435 포트의 실제 연결 중단·복구는 14.12초에 완료됐고, 처리 대기 0건을 확인한 후 실제 15434 터널도 `swax-pc-worker-d1110a` 프로필로 교체했다. prepare PID 60744·printer PID 14728은 유지됐고 감시는 healthy, 공개 API는 200 UP다. 권한/계정/인증서 제한과 활성화 분기 10개 및 기존 복구 9개 시험이 통과했다. 개인키 내보내기·장기 액세스 키 저장·서버 사양 변경은 하지 않았다.

실제 결과는 `var/aws-pc-auth-d1110a/activation-verification.json`, 인증서 역할의 공개 메타데이터는 `ready.json`, 실제 터널 상태는 `var/aws-d1110a/tunnel.json`에 있다. PC가 켜져 있고 Windows 사용자가 로그인해 있어야 한다. 인증서 만료 2027-11-11 16:58:23 KST 전에 인증서를 갱신해야 한다. 실제 재부팅·Windows 로그아웃 시험은 수행하지 않았다.

대회별 등록은 필요 없다. PC 준비 워커는 전체 대회의 대기열을 접수 순서대로 처리하며, 새 대회도 서류를 업로드하면 자동으로 처리한다. 2026-11-11에 임시 대회 ID 제한을 제거했고 재시작 시에도 `event_scope=all`을 유지한다. `verify_active.py`도 전체 대회의 pending/ready 건수를 확인한다. 한글 작업은 기존 공유 mutex로 순차 처리하고 t3.medium 사양은 유지한다.

공식 근거:

- https://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html
- https://docs.aws.amazon.com/rolesanywhere/latest/userguide/trust-model.html
- https://aws.amazon.com/about-aws/whats-new/2023/12/iam-rolesanywhere-additional-aws-regions/
