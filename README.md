# DarkVideoManager

Windows용 로컬 동영상 라이브러리 매니저입니다. 영상 검색, 썸네일, 하이라이트, 별점, 재생 기록과 AI 자막을 관리합니다.

A local-first video library manager for Windows, built with Electron, React and SQLite.

[브라우저 데모](https://dark-video-manager.vercel.app/) · [기능 요청](https://github.com/DarkVideoManager/DarkVideoManager/issues)

## v0.3.5 업데이트

**Windows 10/11 x64**: [설치형 다운로드](https://github.com/doodoocompany/DarkVideoManager/releases/download/v0.3.5/DarkVideoManager-Setup-0.3.5-x64.exe) · [포터블 다운로드](https://github.com/doodoocompany/DarkVideoManager/releases/download/v0.3.5/DarkVideoManager-Portable-0.3.5-x64.exe) · [릴리스와 변경 내역](https://github.com/doodoocompany/DarkVideoManager/releases/tag/v0.3.5)

- **파일 접근 안내**: 외장 드라이브가 빠졌을 때 코덱 오류 대신 연결과 파일 위치를 확인하도록 안내하고, 같은 화면에서 다시 시도할 수 있습니다.
- **반점 별점 저장**: 3.5점·4.5점 등 0.5점 단위 별점의 저장 오류를 수정하고 통계에도 반영합니다.
- **한국어 번역 안정성**: 로컬 Ollama의 느린 응답을 조각 단위로 처리하고 대기 상태를 표시합니다. 원어·완료된 번역은 보존되며, 기존 실패 작업은 큐의 **재개 · 다시 시도**로 이어갑니다. [자막 안내](docs/subtitles.md)

이번 업데이트의 PR별 검토는 [0.3.5 검토 기록](docs/releases/0.3.5-review.md), 실제 배포 파일의 검사 결과·해시·검증하지 못한 환경은 [0.3.5 검증 기록](https://github.com/doodoocompany/DarkVideoManager/releases/download/v0.3.5/VERIFICATION.md)에서 확인하세요. 자동 업데이트·전체화면 3단계와 자막 병렬 실행을 포함한 이전 변경은 [변경 이력](CHANGELOG.md)에 있습니다.

이전 v0.3.0에서는 **Radeon RX 9060 XT / Vulkan / base 모델**로 약 12초 영어 합성 영상의 원어 자막 생성을 확인했습니다. 이는 이번 버전의 모든 GPU·번역·장시간 영상 검증을 대신하지 않습니다. 이전 결과는 [v0.3.0 검증 기록](https://github.com/DarkVideoManager/DarkVideoManager/releases/download/v0.3.0/VERIFICATION.md)에 보존되어 있습니다.

## 주요 기능

0.3.4부터 설치형 앱의 [자동 업데이트](docs/auto-updates.md)를 제공합니다. 0.3.3 이하에는 이 기능이 없으므로 0.3.4 이상의 설치형 파일을 한 번 직접 설치해야 합니다.

- 폴더 가져오기와 검색·정렬, 라이브러리별 SQLite 데이터베이스
- 썸네일 생성과 직접 캡처, [상세 정보에서 대표 썸네일 선택](docs/thumbnails.md), 하이라이트 저장·시간 이동
- 영상 카드·상세 화면·가져오기 창에서 썸네일 진행 상태 확인·개별 중단, 상세 화면에서 재시도
- 이어보기, 재생 위치 탐색, AVI 등 호환 영상 변환 대기열
- 별점·메모·카테고리·태그 편집과 분류 필터, 시청 통계, 설정 백업·복원
- [Stash 메타데이터 가져오기](docs/METADATA_IMPORT.md): 직접 조회한 후보를 확인·수정하고 선택한 제목·메모·태그만 적용
- Vulkan GPU로 AI 자막 생성, 작업 대기열·일시정지·재개
- 자막 없는 영상 필터, SRT·VTT·SMI 자막 검색과 클릭 이동
- 선택적 Google Cloud Translation 또는 로컬 Ollama 번역
- 즐겨찾기·선호 태그·시청 이력 기반 로컬 추천과 조건 검색
- 대체 썸네일과 긴급 탈출 화면 설정: [추천 탐색·화면 보호 안내](docs/library-discovery-and-privacy.md)

AI 작업 중에도 하이라이트와 썸네일을 저장할 수 있습니다. 작업이 남아 있으면 창 닫기는 트레이로 숨기며, 트레이의 **완전히 종료**로 작업을 보관하고 종료합니다.

영상 한 개는 라이브러리의 **영상 파일 추가**로 추가하고, 등록 폴더의 새 영상은 **목록 업데이트**로 반영합니다. 단축키·음량·화면 크기는 앱의 **조작 안내**에서 확인할 수 있습니다. 자세한 사용법은 [영상 추가와 재생 조작](docs/import-and-controls.md)을 참고하세요.

## 사용자 설치

지원 환경은 **Windows 10/11 x64**입니다. 위 v0.3.5 다운로드에서 `Setup`은 설치 안내를 따라 설치하고, `Portable`은 설치 없이 실행합니다. 이후 버전은 [공식 최신 릴리스](https://github.com/doodoocompany/DarkVideoManager/releases/latest)에서 확인할 수 있습니다.

업데이트 전에는 트레이에서도 앱을 완전히 종료하세요. 릴리스의 **Source code** 및 소스 압축 파일은 개발용 코드이며 설치 파일이 아닙니다. 코드에서 직접 실행하려면 아래 소스 빌드 방법을 따릅니다.

v0.3.5 파일의 SHA-256과 검증 범위는 [SHA256SUMS.txt](https://github.com/doodoocompany/DarkVideoManager/releases/download/v0.3.5/SHA256SUMS.txt)와 [VERIFICATION.md](https://github.com/doodoocompany/DarkVideoManager/releases/download/v0.3.5/VERIFICATION.md)에서 확인합니다. 다른 버전에는 해당 릴리스의 자료를 사용하세요. **설치형·포터블은 코드 서명이 없습니다(`NotSigned`).** V3 등 보안 프로그램이 실행을 차단하면 [다운로드 검증·차단 제보 안내](docs/download-verification.md)에 따라 파일 출처, 해시와 탐지 기록을 확인해 주세요. 깨끗한 Windows에서 설치 마법사를 실행하는 검사는 수행하지 않았습니다.

일반 영상 관리·재생·하이라이트에는 API 키가 필요하지 않습니다. 재생 가능 여부는 코덱에 따라 다르며, mpv·VLC·FFplay를 별도 설치해 외부 플레이어로 사용할 수 있습니다.

## 최근 이슈 처리와 지원 범위

2026-10-16 KST 기준으로 아래 이슈를 종료했습니다. **종료 상태는 요청한 모든 기능의 구현이나 모든 환경의 호환성 검증을 뜻하지 않습니다.**

| 이슈                                                                                                                                                              | 완료한 조치와 현재 범위                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#12 GPU 사용 확인](https://github.com/DarkVideoManager/DarkVideoManager/issues/12)                                                                               | 자막 작업의 실제 인식 장치 표시와 위 GPU 검사를 완료했습니다. 오디오 추출 등 CPU 작업은 남아 있으며, 모든 GPU의 성능을 검증한 것은 아닙니다.                                                                         |
| [#13 V3 실행 차단](https://github.com/DarkVideoManager/DarkVideoManager/issues/13)                                                                                | 공식 파일 해시·서명 확인과 탐지 기록 제출 절차를 마련했습니다. 원 제보의 파일·탐지 정보가 없어 차단 원인과 오탐 여부는 미확인입니다. 차단 해제 완료를 뜻하지 않습니다.                                               |
| [#22 메타데이터 분류](https://github.com/DarkVideoManager/DarkVideoManager/issues/22)                                                                             | [Stash에서 직접 조회·검토한 제목·메모·태그를 선택 적용](docs/METADATA_IMPORT.md)하는 1차 범위를 구현했습니다. 자동 일괄 분류·표지 다운로드·다른 제공자 연동은 없으며, 실제 Stash 서버 연결은 별도 검증이 필요합니다. |
| [#24 스트리밍](https://github.com/DarkVideoManager/DarkVideoManager/issues/24) · [#25 모바일·NAS](https://github.com/DarkVideoManager/DarkVideoManager/issues/25) | 수동 대안과 도입 조건을 문서화하고 이번 범위의 기능 개발은 채택하지 않았습니다. URL·라이브 자막, Android 앱, NAS 인증·FTP 연결은 지원하지 않습니다.                                                                  |
| [#26 macOS·ARM](https://github.com/DarkVideoManager/DarkVideoManager/issues/26)                                                                                   | 지원 안내와 이식 검토를 완료했습니다. 배포본은 Windows x64이며 macOS·ARM64 배포본이 없고 Windows ARM에서의 x64 실행은 미검증입니다.                                                                                  |
| [#27 NVIDIA VSR·SVP](https://github.com/DarkVideoManager/DarkVideoManager/issues/27)                                                                              | 기능 차이와 외부 플레이어 검증 조건을 정리했습니다. 직접 연동·자동 활성화 및 실제 RTX·SVP 환경 검증은 완료하지 않았습니다.                                                                                           |

새 플랫폼·연동의 구현 일정은 정해지지 않았습니다. 수동 대안과 도입 조건은 [플랫폼·네트워크 재생 안내](docs/platform-and-playback-scope.md)를 참고하세요.

## 영상 분류와 검색

영상을 선택한 뒤 상세 화면에서 **카테고리**와 **태그**를 입력하고 **분류 저장**을 누릅니다. 카테고리는 영상마다 하나를 지정하며, 기존 카테고리를 재사용하거나 새 이름을 입력할 수 있습니다. 태그는 `선수명, 리그` 또는 `#선수명 #리그`처럼 여러 개를 입력할 수 있습니다.

목록의 **카테고리 필터**와 **태그 필터**를 함께 사용하면 조건을 모두 만족하는 영상만 표시됩니다. **미분류**는 카테고리가 없는 영상입니다. 검색창의 `#선수명`은 해당 태그와 정확히 일치하는 영상을 찾으며, `결승 #선수명`처럼 일반 검색과 함께 사용할 수 있습니다. 선택한 분류 필터는 라이브러리별로 기억합니다.

기존 라이브러리는 처음 열 때 카테고리 저장 항목을 추가하며, 기존 영상·태그·별점·메모는 유지됩니다.

## 재생 조작과 영상 정보

아래 기능은 0.3.0부터 사용할 수 있습니다.

| 기능                | 사용 방법                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 비율로 이동         | 숫자 `0`은 시작, `1`은 10%, `9`는 90% 지점으로 이동합니다. 인앱과 앱에서 실행한 mpv에서 지원하며, Num Lock이 켜진 숫자 키패드도 사용할 수 있습니다.                                                                                          |
| 이동 간격 설정      | **설정 → 재생 탐색 → 기본 탐색 간격 (초)**에서 1~600초 정수를 저장합니다. 기본값은 1초이며, ←/→와 A/D를 한 번 누를 때 적용됩니다. Shift는 5초, Ctrl은 30초를 유지합니다. 인앱은 저장 즉시, mpv는 다음 실행부터 적용됩니다.                   |
| 전체화면            | **전체화면** 또는 `Alt+Enter`로 **영상만 → 하이라이트 위치만 → 전체화면 해제**를 순환합니다. 패널은 숨기고 마우스를 움직이면 전환 버튼이 잠깐 나타납니다. `Esc`로 즉시 해제합니다. **플레이어 최대화**는 상세 패널을 숨기는 별도 기능입니다. |
| 확대·축소           | 인앱의 **+ / −** 버튼이나 키로 100~400% 배율을 조절합니다. 확대한 영상은 드래그로 살펴보고 **화면 맞춤**으로 되돌립니다.                                                                                                                     |
| 재생 정보           | 상단의 **재생 정보** 또는 `I`로 원본 해상도, 현재 재생 해상도, 원본 파일 평균 비트레이트, 프레임 속도, 코덱과 파일 크기를 확인합니다. `Tab`은 키보드 초점 이동에 사용합니다.                                                                 |
| 자막 작업 원본 위치 | **자막 생성** 작업 목록의 **원본 위치 열기**를 누르면 탐색기에서 해당 영상 파일을 선택합니다. 파일이 이동·삭제되었으면 오류를 표시하며 자막 작업은 계속됩니다.                                                                               |

문자 입력 중에는 재생 단축키를 적용하지 않습니다. 외부 플레이어의 전체화면·확대는 해당 플레이어에서 조작하며, VLC·FFplay의 탐색 간격도 해당 플레이어 설정을 따릅니다. 기존 `F`/`T`의 썸네일 저장 동작은 유지합니다.

스트리밍 URL, Android·NAS, macOS·Windows ARM, NVIDIA VSR·SVP의 현재 지원 여부와 후속 검토 범위는 [플랫폼·네트워크 재생 안내](docs/platform-and-playback-scope.md)를 확인하세요. 해당 신규 기능의 출시 또는 호환성을 확약하는 문서는 아닙니다.

## AI 자막과 개인정보

라이브러리에서 영상 선택 → **정보 → AI 자막 생성**에서 모델·언어·한국어 번역 여부를 정하고 **자막 생성 시작**을 누릅니다. 모델 목록에는 `large-v2`와 `large-v3`가 있으며 기본값은 `base`입니다. 영상을 재생하는 것만으로 생성되지 않습니다. 완료된 SRT는 영상 옆에 저장되며 플레이어의 **자막 선택**에서 확인합니다.

새 음성 인식 작업은 Vulkan 지원 GPU와 그래픽 드라이버가 필요하며 CPU로 자동 전환하지 않습니다. 모델은 처음 사용할 때 인터넷으로 다운로드하며, 준비된 모델로 원어 자막을 만들 때 영상과 음성은 로컬에서 처리합니다. 실제 인식 장치는 자막 작업 목록에서 확인하며, 오디오 추출·음성 구간 감지와 번역의 처리 장치는 음성 인식 GPU와 구분합니다.

앱의 **자막 생성 → 자막 환경 자동 설치**에서 음성 인식 모델, WSL Ubuntu의 전용 Python 환경, Ollama와 `qwen3:8b` 번역 모델을 준비할 수 있습니다. Windows에서 관리자 승인이나 재시작을 요구하면 안내에 따라 진행한 뒤 설치를 이어갑니다. 처음 설치할 때는 인터넷 연결과 약 15 GB 이상의 여유 공간을 권장합니다.

Ubuntu는 앱을 실행한 Windows 사용자 계정에 설치합니다. Ubuntu의 사용자 설정 전에는 앱 전용 Linux 계정을 준비해, 나중에 Ubuntu 사용자 설정을 마쳐도 같은 자막 도구와 모델을 계속 사용합니다. 이미 설정한 Ubuntu 사용자 환경은 그대로 사용합니다.

Google 번역은 사용자가 발급한 API 키로 활성화하며 **인식한 자막 텍스트를 Google에 전송하고 비용이 발생할 수 있습니다**. 비활성화하거나 한도에 도달하면 준비된 로컬 Ollama 번역을 사용합니다.

- [AI 자막 설치·사용 안내](docs/subtitles.md)
- [파일명 정리와 정확한 중복 후보](docs/library-maintenance.md)
- [데이터 저장과 외부 전송 안내](docs/PRIVACY.md)

앱 **설정**과 자막 관련 화면의 **개인정보 처리 · 공식 배포 확인**에서 위 안내와 공식 다운로드로 이동할 수 있습니다. 음성 모델·언어 목록, 사양과 비용의 차이, Ubuntu 최초 실행 화면 예시는 자막 안내에 있습니다.

## 소스에서 실행

필요한 환경:

- Windows x64의 **Node.js 24 LTS, 24.18.0 이상**, npm, Git
- 기본 미디어 런타임을 처음 빌드할 때 WSL Ubuntu 24.04 및 `gcc`, `g++`, `make`, `perl`, `python3`, `pkg-config`, `curl`, `tar`, `xz` 사용 가능 환경
- 다운로드를 위한 인터넷 연결과 여유 디스크 공간

```powershell
git clone https://github.com/DarkVideoManager/DarkVideoManager.git
cd DarkVideoManager
npm run setup
npm run dev
```

`setup`은 잠금 파일의 의존성과 Electron을 설치하고, 고정된 소스로 FFmpeg·FFprobe를 준비한 뒤 SQLite와 미디어 실행을 검사합니다. 기존 설치본이나 개인 라이브러리를 복사할 필요가 없습니다. 별도 시스템 도구가 없으면 필요한 항목을 안내하고 종료합니다. 미디어 빌드와 해당 소스 보관 방식은 [외부 구성요소 안내](docs/third-party-licenses.md)를 참고하세요.

선택적 AI 런타임 설치:

```powershell
npm run setup:subtitles:gpu
npm run setup:subtitles
```

기본 WSL 배포판은 `Ubuntu-24.04`입니다. 다른 배포판 사용 방법과 GPU·번역 모델 조건은 AI 자막 안내에 있습니다.

## 검사와 패키징

```powershell
npm run audit:publication
npm run typecheck
npm run lint
npm test
npm run test:tooling
npm run test:e2e
npm run build
npm run test:electron
npm run build:unpacked
```

웹 화면 테스트에는 설치된 Chrome 또는 Playwright Chromium이 필요합니다. Chrome이 없다면 `npx playwright install chromium`을 실행합니다. 테스트는 임시 영상과 별도 앱 데이터 폴더를 사용합니다.

개발용 실행 폴더는 `dist-electron/win-unpacked/`입니다. 공개 배포는 라이선스와 대응 소스 검사까지 포함하는 [릴리스 절차](docs/release.md)를 따르세요. 소스만 전달할 때는 `npm run export:source`로 개인 데이터·빌드 출력·Git 이력을 제외한 압축 파일을 만듭니다.

## 기여와 지원

버그 신고에는 앱 버전, 운영체제, 재현 순서를 포함하세요. 개인 영상·자막·API 키·실제 라이브러리 DB는 첨부하지 마세요.

- [기여 방법](CONTRIBUTING.md)
- [보안 문제 제보](SECURITY.md)
- [변경 이력](CHANGELOG.md)

## 라이선스와 출처

자체 코드와 아이콘은 [MIT](LICENSE)로 공개합니다. 포함된 외부 프로그램과 라이브러리는 각각의 라이선스를 따릅니다. FFmpeg·x264의 GPL 조건과 대응 소스 제공은 별도로 적용됩니다.

[외부 라이선스 안내](THIRD_PARTY_NOTICES.md) · [코드·자산 출처](docs/PROVENANCE.md)

기존 [설계 초안](docs/design-original.md)과 [배포본 복구 기록](docs/restoration.md)은 이력 자료입니다. 현재 지원 기능과 설치 방법은 이 README를 기준으로 확인하세요.
