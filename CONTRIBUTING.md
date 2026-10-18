# Contributing to PocketRisu

[한국어](#한국어)

Thank you for helping PocketRisu. This page explains how issues and pull requests are handled, so you know what to expect before you spend time on a change.

## Before you start

- **Bug reports** — include the PocketRisu version, how you installed it (portable, Docker, Termux, source), the browser/device you access it from, whether you connect remotely (Tailscale, tunnel, …), and any browser console or server log lines around the problem.
- **Larger changes** — for new features, storage/format changes, or anything that touches many files, please open an issue first so we can agree on the direction. Small fixes and translations can go straight to a pull request.

## How pull requests are handled

- **Merged as is** — focused bug fixes, translations, documentation, and other clear changes are merged with your authorship kept. We may squash the commits or tidy the title, and add follow-up commits ourselves (tests, small adjustments) instead of asking you for another round.
- **Reworked by us** — when a change affects data compatibility, the storage format, or a large part of the code, we may re-implement the idea to fit the codebase's conventions instead of merging the branch. When we do, we credit you: a `Co-authored-by:` trailer on the commit, a mention in the release notes, and a comment on your pull request linking the commit that landed it.
- **Not taken** — if a change does not fit the project's direction, we close it with the reason.

## What we look for

- **Node.js only.** PocketRisu runs as a Node.js server and is used from a browser, often remotely on a phone. Please don't add branches for Tauri, Capacitor, or the hosted web version.
- **Existing data stays readable.** Users update with their `save` folder in place and move data with `.bin` backups. A change must keep existing save folders and backups working, including backups from upstream RisuAI, and PocketRisu backups must stay importable by upstream RisuAI.
- **Small upstream diff.** Avoid restructuring code that mirrors upstream RisuAI unless the change needs it.
- **Checks pass.** Use `pnpm` (not npm). Run `pnpm run check` and `pnpm test` before opening the pull request.
- **Target branch.** Open pull requests against `develop` when possible; `main` holds the latest release.

---

## 한국어

PocketRisu에 기여해 주셔서 감사합니다. 변경에 시간을 쓰기 전에 이슈와 PR이 어떻게 처리되는지 알 수 있도록 정리한 문서입니다.

### 시작하기 전에

- **버그 제보** — PocketRisu 버전, 설치 방식(포터블·Docker·Termux·소스), 접속하는 브라우저/기기, 원격 접속 여부(Tailscale, 터널 등), 문제 전후의 브라우저 콘솔이나 서버 로그를 함께 적어 주세요.
- **큰 변경** — 새 기능, 저장 구조·포맷 변경, 여러 파일에 걸친 변경은 먼저 이슈로 방향을 맞춰 주세요. 작은 수정과 번역은 바로 PR을 보내셔도 됩니다.

### PR 처리 방식

- **그대로 머지** — 범위가 분명한 버그 수정, 번역, 문서 등은 작성자 정보를 유지한 채 머지합니다. 커밋을 하나로 합치거나 제목을 다듬을 수 있고, 테스트나 작은 보완은 다시 요청하지 않고 저희가 후속 커밋으로 처리합니다.
- **저희가 다시 구현** — 데이터 호환성이나 저장 구조, 코드의 넓은 범위에 영향을 주는 변경은 브랜치를 머지하는 대신 코드베이스 관례에 맞춰 아이디어를 다시 구현할 수 있습니다. 이 경우 반드시 크레딧을 남깁니다: 커밋의 `Co-authored-by:`, 릴리즈 노트 언급, 그리고 반영된 커밋 링크를 PR에 코멘트로 남깁니다.
- **반영하지 않음** — 프로젝트 방향과 맞지 않으면 사유를 남기고 닫습니다.

### 기준

- **Node.js 전용.** PocketRisu는 Node.js 서버로 실행하고 브라우저(주로 휴대폰 원격 접속)로 사용합니다. Tauri·Capacitor·웹 버전용 분기는 추가하지 말아 주세요.
- **기존 데이터는 계속 읽혀야 합니다.** 사용자는 `save` 폴더를 둔 채 업데이트하고, `.bin` 백업으로 데이터를 옮깁니다. 기존 save 폴더와 백업(원본 RisuAI 백업 포함)이 그대로 동작해야 하고, PocketRisu 백업은 원본 RisuAI에서도 가져올 수 있어야 합니다.
- **업스트림과의 차이는 작게.** 원본 RisuAI와 같은 구조의 코드는 꼭 필요할 때만 재구성해 주세요.
- **검사 통과.** npm 대신 `pnpm`을 사용하고, PR 전에 `pnpm run check`와 `pnpm test`를 실행해 주세요.
- **대상 브랜치.** 가능하면 `develop`으로 PR을 열어 주세요. `main`은 최신 릴리즈입니다.
