# 화접몽 한의원 GEO Auto-Publisher

피부질환 콘텐츠 자동 생성·발행 시스템 (GEO 최적화)

## 프로젝트 구조

```
hwajeopmong-auto-publisher/
├── src/
│   ├── config.js              # 질환 토픽, 스케줄, API 설정 (★ 질환 추가는 여기서)
│   ├── content-generator.js   # 3단계 AI 파이프라인 (리서치→전략→프로덕션)
│   ├── schema-generator.js    # JSON-LD 스키마 자동 생성
│   ├── wordpress-publisher.js # WordPress REST API 발행
│   ├── worker.js              # Cloudflare Workers 엔트리 (Cron + HTTP)
│   ├── server.js              # Railway/로컬 실행용 Node.js 서버
│   ├── dashboard.html         # 모니터링 대시보드 UI
│   └── manual-publish.js      # 수동 발행 CLI 스크립트
├── wordpress-setup/
│   ├── robots.txt             # AI 크롤러 허용 설정 → WP 루트에 배치
│   ├── llms.txt               # AI 크롤러용 사이트 구조 안내 → WP 루트에 배치
│   └── functions-snippet.php  # WP functions.php 추가 코드
├── data/                      # 발행 이력 (자동 생성, git 무시)
├── wrangler.toml              # Cloudflare Workers 설정
├── package.json
└── README.md
```

## 빠른 시작

### 1단계: 환경변수 설정

```bash
# .env 파일 생성 (Railway에서는 대시보드에서 설정)
OPENAI_API_KEY=sk-...                           # OpenAI API 키 (필수)
WP_ACCESS_TOKEN=your-oauth-token                # WordPress.com OAuth 토큰 (필수)
WP_SITE_ID=mongclinictest.wordpress.com         # WordPress.com 사이트 ID (기본값 있음)
PEXELS_API_KEY=...                              # Pexels 이미지 API 키 (선택)
```

**OpenAI API 키 발급:**
1. [platform.openai.com](https://platform.openai.com) 접속
2. 좌측 메뉴 "API Keys" 클릭
3. "Create new secret key" → 키 생성
4. 기존 KOCOBOX에서 사용 중인 API 키 재활용 가능

**WordPress.com OAuth 토큰 발급:**
1. 브라우저에서 아래 URL 접속:
   `https://public-api.wordpress.com/oauth2/authorize?client_id=137509&redirect_uri=https://example.com&response_type=token`
2. 승인 클릭 → 리디렉션된 URL에서 `access_token=` 뒤의 값 복사
3. ⚠️ 토큰은 14일마다 만료되므로 위 과정을 반복하여 갱신

### 2단계: WordPress 앱 비밀번호 생성

1. WordPress 관리자 → 사용자 → 프로필
2. "애플리케이션 비밀번호" 섹션
3. 이름: `auto-publisher` → "새 애플리케이션 비밀번호 생성"
4. 생성된 비밀번호를 `WP_APP_PASSWORD`에 설정

### 3단계A: Cloudflare Workers 배포 (권장)

```bash
# wrangler.toml에서 KV namespace ID 설정 후
npm install
npx wrangler kv:namespace create HWJ_KV
# 출력된 ID를 wrangler.toml에 입력

# 환경변수 설정
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put WP_ACCESS_TOKEN
npx wrangler secret put PEXELS_API_KEY

# 배포
npx wrangler deploy
```

배포 후 Cron이 매일 09:00, 14:00 KST에 자동 실행됩니다.

### 3단계B: Railway 배포 (대안)

```bash
# GitHub에 푸시 후 Railway에 연결
# Railway 대시보드에서 환경변수 설정
# 자동 배포 → server.js가 node-cron으로 스케줄 실행
```

### 3단계C: 로컬 실행 (테스트)

```bash
npm install
node src/server.js
# 대시보드: http://localhost:3000/dashboard
```

## 수동 발행

```bash
# 다음 토픽 자동 선택
node src/manual-publish.js

# 특정 토픽 지정
node src/manual-publish.js --topic acne --type faq

# 생성만 하고 발행 안 함 (미리보기)
node src/manual-publish.js --dry-run

# 사용 가능한 토픽 ID:
# flat-warts, keratosis-pilaris, folliculitis, acne,
# atopic-dermatitis, acne-scars, psoriasis, dyshidrosis,
# diet, seborrheic-dermatitis

# 사용 가능한 콘텐츠 유형 ID:
# comprehensive-guide, korean-medicine-treatment, faq,
# case-study, comparison
```

## 질환 추가 방법

`src/config.js`의 `TOPICS` 배열에 새 객체를 추가하면 됩니다:

```javascript
{
  id: 'new-disease',           // 고유 ID (영문)
  name: '새 질환명',            // 한글 질환명
  nameEn: 'New Disease',       // 영문 질환명
  slug: 'new-disease',         // URL 슬러그
  category: '피부질환',         // 카테고리
  keywords: ['키워드1', '키워드2'],  // 타겟 키워드
  medicalName: 'Medical Name', // 의학 명칭
  icd10: 'L00.0',             // ICD-10 코드
  pexelsQuery: 'skin care',   // Pexels 이미지 검색어
  description: '질환 설명',     // 간단한 설명
}
```

추가 후 자동으로 5가지 콘텐츠 유형(종합가이드, 한방치료법, FAQ, 치료사례, 비교분석)이
로테이션에 포함됩니다.

## WordPress 초기 설정

1. **robots.txt**: `wordpress-setup/robots.txt` 내용을 WordPress 루트에 배치
2. **llms.txt**: `wordpress-setup/llms.txt`를 WordPress 루트에 업로드
3. **functions.php**: `wordpress-setup/functions-snippet.php` 코드를 테마 functions.php에 추가
4. **필수 플러그인 설치**:
   - RankMath SEO (스키마 마크업 + SEO 관리)
   - MAIO Analytics (AI 크롤러 트래킹) — 선택

## API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/dashboard` | GET | 모니터링 대시보드 |
| `/api/status` | GET | 시스템 상태 (연결, 진행률) |
| `/api/topics` | GET | 질환별 발행 현황 매트릭스 |
| `/api/recent-posts` | GET | 최근 발행 목록 |
| `/api/errors` | GET | 에러 로그 |
| `/api/publish-now` | POST | 수동 발행 트리거 |
| `/api/reset-history` | POST | 발행 이력 초기화 |

## 아키텍처

```
[Cron 09:00/14:00 KST]
        │
        ▼
[Stage 1: 리서치 AI] ─── GPT-4o-mini ──→ 트렌드·키워드·환자질문 수집
        │
        ▼
[Stage 2: 전략 AI] ──── GPT-4o-mini ──→ 제목·구조·앵글 기획
        │
        ▼
[Stage 3: 프로덕션 AI] ─ GPT-4o-mini ──→ HTML 본문 + FAQ + 참고문헌
        │
        ├──→ [Pexels API] ──→ 이미지 삽입
        ├──→ [Schema Generator] ──→ JSON-LD 스키마 5종 삽입
        │
        ▼
[WordPress REST API] ──→ 글 발행 (draft/publish)
        │
        ▼
[Dashboard] ──→ 발행 현황 모니터링
```

## 콘텐츠 로테이션

10개 질환 × 5가지 유형 = 총 50개 콘텐츠를 순차적으로 생성합니다.
하루 2건 발행 기준 약 25일(영업일)에 초기 콘텐츠 세팅이 완료됩니다.
50개 모두 발행된 후에는 가장 오래된 콘텐츠부터 업데이트 버전을 재생성합니다.

## 기존 KOCOBOX와의 차이점

| 항목 | KOCOBOX | 화접몽 |
|------|---------|--------|
| AI 모델 | GPT-4o-mini (유료) | GPT-4o-mini (유료, KOCOBOX 키 재활용) |
| 파이프라인 | 단일 프롬프트 | 3단계 (리서치→전략→프로덕션) |
| 톤 | 클릭베이트 | 전문적·신뢰감·환자 중심 |
| 스키마 | 기본 SEO | MedicalCondition + FAQPage + Article + LocalBusiness + Breadcrumb |
| 발행 주기 | 6건/일 | 2건/일 (품질 중심) |
| 서버 | Railway 전용 | CF Workers (주) + Railway (호환) |
| 이미지 | DALL-E 3 | Pexels (의료 적합성) |
