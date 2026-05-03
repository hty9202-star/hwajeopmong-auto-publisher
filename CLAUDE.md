# 화접몽 GEO Auto-Publisher — 프로젝트 메모리

## 프로젝트 경로 (절대 변경 금지)

**작업 경로: `C:\project\hwajeopmong-auto-publisher`**

- 이전 경로 `C:\Users\7dayis-240829\Desktop\hwajeopmong-auto-publisher`는 폐기됨
- 모든 파일 읽기/쓰기/편집은 반드시 `C:\project\hwajeopmong-auto-publisher` 기준
- bash에서는 `/sessions/.../mnt/hwajeopmong-auto-publisher/` (세션마다 다름)
- 사용자에게 명령어 전달 시 반드시 `cd C:\project\hwajeopmong-auto-publisher` 포함할 것
- GitHub: `https://github.com/hty9202-star/hwajeopmong-auto-publisher.git`
- Supabase 프로젝트 ID: `vqoxcfanflbvxopvdgdj`

## 핵심 파일 구조

```
C:\project\hwajeopmong-auto-publisher\
├── package.json
├── wrangler.toml
├── .gitignore
├── README.md
├── CLAUDE.md          ← 이 파일
├── src/
│   ├── server.js              # 메인 서버 (Node.js + Supabase) ~1424줄
│   ├── dashboard.html         # 관리자 대시보드 ~2105줄
│   ├── settings.html          # 설정 페이지
│   ├── content-generator.js   # Gemini 2.5 Flash 콘텐츠 생성기
│   ├── config.js              # 설정 (질환 목록, 콘텐츠 유형)
│   ├── worker.js              # Cloudflare Workers 엔트리
│   ├── wordpress-publisher.js # WordPress REST API 발행
│   ├── schema-generator.js    # JSON-LD 스키마 생성
│   └── manual-publish.js      # 수동 발행 스크립트
├── data/reference/            # 참고자료 텍스트 파일
└── wordpress-setup/           # WordPress 설정 파일
```

## 파일 동기화 주의사항 (중요!)

Cowork에는 3개의 독립 파일 시스템이 있어서 동기화 문제가 발생한다:
1. Edit/Read 도구 — Claude 내부 가상 레이어
2. Bash 샌드박스 — 격리된 Linux VM
3. 사용자 PC — 실제 Windows 파일 시스템

이로 인해 발생하는 문제와 대응 방법:
- 파일 잘림: 큰 파일(100KB+) 수정 시 bash에서 원본 크기만큼만 보일 수 있음 → 수정 후 반드시 tail로 끝부분 확인
- 동기화 불일치: Edit 도구 수정이 PC에 반영 안 될 수 있음 → 수정 파일은 Chrome 다운로드로 PC에 전달
- Git lock: 샌드박스에서 git 작업 실패 시 .lock 파일 잔류 → 샌드박스에서 git commit/push 하지 말 것
- Push rejected: 여러 경로에서 커밋 시도 시 히스토리 불일치 → git pull --rebase 후 push

## 커밋/배포 절차 (반드시 따를 것)

1. 코드 수정은 Edit 도구 또는 bash python으로 수행
2. 수정 파일을 Chrome 다운로드 버튼으로 PC에 전달 (동기화가 안 될 경우)
3. 커밋은 반드시 사용자 PC 터미널에서 실행:
   ```
   cd C:\project\hwajeopmong-auto-publisher
   git add [파일명]
   git commit -m "메시지"
   git push origin main
   ```
4. push rejected 시: `git pull --rebase origin main` 후 다시 push
5. lock 파일 오류 시: `del /F .git\index.lock` 또는 `del /F .git\HEAD.lock`

## 파일 편집 규칙

- 파일 수정 시 전체 파일을 덮어쓰지 말 것 (Edit 도구로 부분 수정)
- dashboard.html은 ~2105줄로 큰 파일 — 반드시 부분 읽기/편집
- server.js는 ~1424줄 — 마찬가지로 부분 편집 권장
- content-generator.js도 대형 파일 — 잘림 주의
- 경로를 Desktop이나 다른 경로로 변경하지 않기
- 파일 Write 시 기존 내용 유실 방지 (Read 먼저)
- 큰 파일은 한 번에 Write하지 않기

## 최근 작업 이력

- 2025-05-03: 인용 점수 계산 통일 (상단 카드 + 질환 테이블 + 7회 현황표 → 동일한 날짜기반 집계 방식)
- 인용추적 데이터: 현재 gemini만 존재, chatgpt/claude API 키 미설정 상태
