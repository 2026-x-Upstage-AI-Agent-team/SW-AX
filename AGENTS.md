# 프로젝트 작업 안내

이 프로젝트를 이어서 작업할 때는 먼저 [PROJECT_PLAN.md](PROJECT_PLAN.md)를 읽고, 확정된 요구사항과 현재 진행 상태를 확인한다.

- 문서 분류·추출·판정은 Upstage Studio의 노코드 워크플로우가 맡는다. 사용자 요청 없이 판정 로직을 별도 애플리케이션으로 옮기지 않는다.
- 운영판 담당자 화면은 React, 백엔드 API는 Spring Boot로 확정했다. [운영판 전환 계획](docs/IMPLEMENTATION_PLAN.md#운영판-전환)과 [Windows 시연판 실행 안내](docs/LOCAL_SERVICE.md)를 참고한다.
- 한 팀의 대표가 팀원 전체 정보를 포함한 01·02·03 문서를 제출한다. 처리 단위는 학생 한 명이 아니라 한 팀의 제출 묶음이다.
- 00번 지급내역서는 실행 입력에서 제외한다. 시상구분과 지원액은 `미확인`으로 출력하고 담당자가 팀별로 입력한다.
- Studio의 데이터 Merge와 최종 PDF 페이지 병합을 구분한다. 실행으로 확인하지 않은 기능을 구현 완료로 보고하지 않는다.
- Studio 구성용 프롬프트는 [docs/STUDIO_BUILD_PROMPT.txt](docs/STUDIO_BUILD_PROMPT.txt)에 있다.
- 최종 테스트 입력은 `test case/upstage_data.zip`의 `upstage_data/set01`~`set20`에 담긴 한글 제출 문서 58개다. 압축을 푼 `test case/upstage_data/`에서도 같은 원본을 사용할 수 있다. 실행 후에만 `docs/유잇_미션2_유형표.xlsx`의 문서별 기준 및 `output/json/유잇_미션2_answer.json`의 팀별 기대 판정과 대조한다.
- 원본 ZIP과 HWP/HWPX를 보존한다. 팀 폴더에 실제 들어 있는 제출본을 그대로 사용해 누락·중복을 검사한다.
- 새로운 사용자 결정이나 실제 Studio 실행 결과가 생기면 `PROJECT_PLAN.md`의 해당 내용과 진행 상태를 갱신한다.

사용자의 최신 지시와 개인 전역 지침을 함께 적용한다.
