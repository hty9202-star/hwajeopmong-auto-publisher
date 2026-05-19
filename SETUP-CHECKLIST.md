# GEO Auto-Publisher 셋업 체크리스트

> SETUP-GUIDE.md와 함께 사용하세요. 각 단계를 순서대로 완료하면 됩니다.

---

## Phase 1: 계정 준비

- [ ] GitHub 계정 생성 및 저장소 fork/clone
- [ ] Supabase 프로젝트 생성 (무료 플랜 OK)
  - [ ] Project URL 메모: `https://xxxx.supabase.co`
  - [ ] anon key 메모
- [ ] WordPress.com 사이트 개설
  - [ ] 사이트 주소 확정: `yoursite.wordpress.com`
  - [ ] OAuth 토큰 발급 (REST API용)
- [ ] Render.com 계정 생성
  - [ ] Starter 플랜($7/월) 권장 (무료 플랜은 15분 비활동 시 중지)
- [ ] Google AI Studio에서 Gemini API 키 발급
- [ ] 이미지 API 키 최소 1개 발급
  - [ ] Pixabay API 키
  - [ ] Unsplash Access Key (선택)
  - [ ] Pexels API 키 (선택)

---

## Phase 2: 코드 커스터마이징

### config.js — BRAND 정보 수정
- [ ] `name`: 브랜드/병원명 (한글)
- [ ] `nameEn`: 영문명
- [ ] `specialty`: 전문 분야 한 줄 설명
- [ ] `tone`: 원하는 콘텐츠 톤
- [ ] `url`: 실제 WordPress 사이트 URL
- [ ] `phone`: 실제 전화번호
- [ ] `address`: 실제 주소
- [ ] `doctor.name`: 대표 전문가명
- [ ] `doctor.title`: 직함
- [ ] `doctor.specialty`: 세부 전문분야

### config.js — TOPICS 수정
- [ ] 기존 피부질환 토픽 → 해당 업종 토픽으로 교체
- [ ] 각 토픽에 `id`, `name`, `nameEn`, `slug`, `category`, `keywords` 설정
- [ ] `medicalName`, `icd10` (의료 분야가 아니면 제거 가능)
- [ ] `pexelsQuery`: 이미지 검색 키워드 설정

### config.js — CONTENT_TYPES 수정
- [ ] 업종에 맞게 콘텐츠 유형 5종 조정
- [ ] `titlePattern`의 `{disease}` → 업종에 맞는 변수명으로 변경

### config.js — WP_CATEGORIES 수정
- [ ] 카테고리 이름과 slug 업종에 맞게 변경

### content-generator.js — AI 프롬프트 수정
- [ ] 시스템 프롬프트에서 업종/톤/금지사항 수정
- [ ] 의료 분야가 아니면 의료법 관련 지시 제거
- [ ] 참고자료 디렉토리(`data/reference/`)에 브랜드 기존 콘텐츠 추가

### schema-generator.js — JSON-LD 타입 수정
- [ ] 업종에 맞는 schema.org 타입으로 변경
  - 의료: MedicalCondition, MedicalClinic, Physician
  - 법률: LegalService, Attorney
  - 교육: EducationalOrganization, Course
  - 일반: LocalBusiness, Article

---

## Phase 3: Supabase 데이터베이스 설정

SQL Editor에서 아래 테이블을 순서대로 생성:

- [ ] `content_queue` 테이블 생성 (SETUP-GUIDE.md의 SQL 참조)
- [ ] `topics` 테이블 생성
- [ ] `settings` 테이블 생성
- [ ] `publish_logs` 테이블 생성
- [ ] `error_logs` 테이블 생성
- [ ] `citation_results` 테이블 생성
- [ ] 초기 토픽 데이터 INSERT (config.js의 TOPICS 배열 기반)

---

## Phase 4: 환경변수 설정

`.env` 파일 생성 또는 Render.com Environment Variables에 등록:

### 필수
- [ ] `GEMINI_API_KEY`
- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_KEY`
- [ ] `WP_SITE_ID` (예: yoursite.wordpress.com)
- [ ] `WP_ACCESS_TOKEN`
- [ ] `ADMIN_PASSWORD` (대시보드 접근용, 직접 설정)
- [ ] `CLIENT_TOKEN` (클라이언트 대시보드용, 직접 설정)

### 선택 (이미지)
- [ ] `PIXABAY_API_KEY`
- [ ] `UNSPLASH_ACCESS_KEY`
- [ ] `PEXELS_API_KEY`

### 선택 (인용추적)
- [ ] `OPENAI_API_KEY` (ChatGPT 인용추적용)
- [ ] `ANTHROPIC_API_KEY` (Claude 인용추적용)

---

## Phase 5: Render.com 배포

- [ ] New Web Service 생성
- [ ] GitHub 저장소 연결
- [ ] Build Command: `npm install`
- [ ] Start Command: `node src/server.js`
- [ ] 환경변수 모두 등록 (Phase 4)
- [ ] 배포 완료 확인
- [ ] 서버 URL 메모: `https://your-app.onrender.com`

---

## Phase 6: 초기 설정 및 테스트

- [ ] `[서버URL]/settings` 접속 → ADMIN_PASSWORD로 로그인
- [ ] 발행 주기 설정 (기본: 하루 5슬롯)
- [ ] 발행 시간대 설정 (기본: 09, 11, 13, 15, 17시 KST)
- [ ] 발행 상태 설정 (`draft` 또는 `publish`)
- [ ] 이미지 API 키 등록 확인
- [ ] 질환/토픽 관리 페이지에서 토픽 확인
- [ ] **테스트 발행 실행** → WordPress에 글이 올라가는지 확인
- [ ] 대시보드(`[서버URL]/dashboard`)에서 발행 현황 확인

---

## Phase 7: 운영 점검

- [ ] WordPress OAuth 토큰 갱신 주기 확인 (14일)
- [ ] Render.com 플랜 확인 (무료 = cron 불가)
- [ ] 에러 로그 모니터링 방법 확인
- [ ] 클라이언트 대시보드 URL 공유 (필요 시)

---

## 트러블슈팅 빠른 참조

| 증상 | 원인 | 해결 |
|------|------|------|
| 발행 실패 | WP 토큰 만료 | OAuth 토큰 재발급 후 환경변수 업데이트 |
| cron 미실행 | Render 무료 플랜 서버 중지 | Starter 플랜 업그레이드 |
| 이미지 없음 | 이미지 API 키 미등록 | 최소 1개 키 등록 |
| DB 연결 실패 | Supabase URL/Key 오류 | 환경변수 재확인 |
| 콘텐츠 생성 실패 | Gemini API 키 오류/할당량 | API 키 및 사용량 확인 |

---

*이 체크리스트의 각 항목을 완료하면 자동 발행 시스템이 가동됩니다.*
*상세 설명은 SETUP-GUIDE.md를 참조하세요.*
