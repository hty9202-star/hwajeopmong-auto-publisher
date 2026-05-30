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

(git 히스토리 기준 — 최신순. 갱신: 2026-05-30)

- 2026-05-26: 광고주 미리보기 풀스크린 모달 추가 + 수정 시 script 태그 숨김
- 2026-05-26: 모듈분리 버그 수정 (return jsonRes 패턴, 품질점수 프로퍼티명, headersSent 가드, 에러로그 타임스탬프, 광고주 인증헤더)
- 2026-05-25~26: "Cannot write headers" 에러 완전 수정 (res.headersSent 가드) + 광고주 대시보드 발행일정/기간 미표시 수정 (인증 헤더 누락)
- 2026-05-24: 발행 후 검색엔진 자동 알림 (IndexNow + Google/Bing ping) + MedicalWebPage Speakable 스키마 (GEO 음성 인용 최적화)
- 2026-05-20: server.js 모듈 분리 (2184줄 → src/lib/*, src/routes/* 10개 파일)
- 2026-05-18: 보안 심각 이슈 5건 수정 (비밀번호 하드코딩 제거, CORS 제한, XSS 방지, 인증 추가)
- 2026-05-12~15: Claude 인용추적 web_search 도구 추가 + rate limit 수정 (순차 호출·재시도), 질환별 현황 날짜기반 필터

## 현재 코드 구조 메모 (2026-05-30 확인)

- server.js는 모듈 분리됨: `src/lib/` (auth, citation, env, helpers, publisher), `src/routes/` (admin, client, citation, report)
- 콘텐츠 생성기: Gemini 2.5 Flash (content-generator.js)
- 인용추적 데이터: gemini 중심, chatgpt/claude는 API 키 설정 여부에 따라 작동
- `patch-websearch.js`: 일회성 패치 스크립트 (git 미추적)

## 줄바꿈(CRLF) 주의

- 저장소 표준은 LF. Windows 에디터/일부 bash 쓰기가 dashboard.html 등을 CRLF로 바꾸면
  내용 변경이 없어도 git에 "전체 줄 변경"으로 잡힘 → `git diff --ignore-all-space`로 확인
- `.gitattributes`에 정규화 규칙을 추가해 재발 방지함
