# GEO Auto-Publisher 셋업 가이드

> AI 콘텐츠 자동 발행 + GEO 최적화 + 인용추적 시스템을 새 프로젝트에 구축하기 위한 가이드

## 1. 사전 준비물

| 항목 | 설명 | 비용 |
|------|------|------|
| GitHub 계정 | 코드 저장소 | 무료 |
| Supabase 프로젝트 | PostgreSQL 데이터베이스 | 무료 (500MB) |
| WordPress.com 사이트 | 콘텐츠 발행 CMS | 무료~ |
| Render.com 계정 | 서버 호스팅 | Starter $7/월 권장 |
| Google AI Studio 키 | Gemini 콘텐츠 생성 | 유료 (Flash: 저렴) |
| 이미지 API 키 1개 이상 | Pixabay/Unsplash/Pexels | 무료 |

## 2. 파일 구조

```
project-root/
├── package.json
├── CLAUDE.md              # AI 어시스턴트 메모리
├── SETUP-GUIDE.md         # 이 파일
├── SETUP-CHECKLIST.md     # 셋업 체크리스트
├── src/
│   ├── config.js              # ★ 브랜드 정보, 콘텐츠 유형, AI 설정
│   ├── server.js              # 메인 서버 (API + cron + 발행)
│   ├── content-generator.js   # ★ AI 프롬프트 + 콘텐츠 생성
│   ├── wordpress-publisher.js # WordPress REST API 연동
│   ├── schema-generator.js    # ★ JSON-LD 구조화 데이터
│   ├── supabase-client.js     # DB 클라이언트
│   ├── dashboard.html         # 관리자 대시보드
│   ├── client-dashboard.html  # 광고주 대시보드
│   └── settings.html          # 설정 페이지
├── data/reference/            # ★ 참고자료 (톤 학습용)
└── wordpress-setup/           # WP 설정 파일
```

> ★ 표시 = 새 프로젝트 시 반드시 커스터마이징 필요

## 3. 환경변수

`.env` 파일 (로컬) 또는 Render.com Environment Variables에 등록:

```env
# === 필수 ===
GEMINI_API_KEY=your_gemini_api_key
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=your_supabase_anon_key
WP_SITE_ID=yoursite.wordpress.com
WP_ACCESS_TOKEN=your_wp_oauth_token
ADMIN_PASSWORD=your_admin_password
CLIENT_TOKEN=your_client_token

# === 선택 (이미지 - 최소 1개 권장) ===
PIXABAY_API_KEY=your_pixabay_key
UNSPLASH_ACCESS_KEY=your_unsplash_key
PEXELS_API_KEY=your_pexels_key

# === 선택 (인용추적) ===
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
```

## 4. Supabase 테이블

SQL Editor에서 실행할 테이블 6개:

| 테이블 | 용도 |
|--------|------|
| `content_queue` | 발행 콘텐츠 큐 (제목, 본문, 상태, 점수) |
| `publish_logs` | 발행 이력 로그 |
| `topics` | 질환/토픽 목록 (동적 관리) |
| `settings` | 시스템 설정 (JSON key-value) |
| `error_logs` | 에러 로그 |
| `citation_results` | AI 인용추적 결과 |

### content_queue 주요 컬럼

```sql
CREATE TABLE content_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  queue_id TEXT,
  combo_id TEXT,
  topic_id TEXT,
  content_type_id TEXT,
  topic_name TEXT,
  content_type_name TEXT,
  title TEXT,
  slug TEXT,
  content TEXT,
  excerpt TEXT,
  meta_description TEXT,
  category TEXT,
  tags JSONB DEFAULT '[]',
  hero_image_url TEXT,
  schemas JSONB,
  faq JSONB,
  status TEXT DEFAULT 'pending',
  is_test BOOLEAN DEFAULT false,
  republished_from JSONB,
  wp_post_id INTEGER,
  wp_post_url TEXT,
  review_status TEXT,
  review_fixes INTEGER DEFAULT 0,
  geo_score INTEGER DEFAULT 0,
  eeat_score INTEGER DEFAULT 0,
  geo_details JSONB DEFAULT '{}',
  eeat_details JSONB DEFAULT '{}',
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ
);
```

### topics 테이블

```sql
CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_en TEXT,
  slug TEXT,
  category TEXT,
  keywords JSONB DEFAULT '[]',
  medical_name TEXT,
  icd10 TEXT,
  pexels_query TEXT,
  description TEXT,
  related_topics JSONB DEFAULT '[]',
  subtopics JSONB DEFAULT '[]',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 기타 테이블

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE publish_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  queue_id TEXT,
  combo_id TEXT,
  status TEXT,
  published_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE error_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT,
  message TEXT,
  stack TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE citation_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  topic_id TEXT,
  topic_name TEXT,
  model TEXT,
  query TEXT,
  score NUMERIC,
  mentioned BOOLEAN DEFAULT false,
  cited BOOLEAN DEFAULT false,
  details JSONB DEFAULT '{}',
  tracked_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 5. 커스터마이징 포인트 (★ 핵심)

### config.js — BRAND 객체
```javascript
export const BRAND = {
  name: '병원/브랜드명',
  nameEn: 'English Name',
  specialty: '전문 분야 한 줄 설명',
  tone: '원하는 콘텐츠 톤 설명',
  url: 'https://your-website.com',
  phone: '+82-XX-XXXX-XXXX',
  address: '주소',
  doctor: {
    name: '대표 전문가명',
    title: '직함',
    specialty: '세부 전문분야',
  },
};
```

### config.js — TOPICS (초기 토픽)
설정 페이지에서 동적으로 추가/수정/삭제 가능하지만, 초기 목록을 config.js에 미리 넣어두면 좋습니다.

### content-generator.js — AI 프롬프트
시스템 프롬프트에서 업종, 톤, 금지사항 등을 수정합니다. 의료 분야가 아닌 경우 의료법 관련 지시를 제거하세요.

### schema-generator.js — JSON-LD 타입
업종에 맞는 schema.org 타입으로 변경:
- 의료: MedicalCondition, MedicalClinic, Physician
- 법률: LegalService, Attorney
- 교육: EducationalOrganization, Course
- 일반: LocalBusiness, Article

### data/reference/ — 참고자료
브랜드의 기존 블로그/콘텐츠를 텍스트 파일로 넣으면, AI가 톤앤매너를 학습합니다.

## 6. 배포 절차

```bash
# 1. 저장소 클론
git clone https://github.com/[org]/geo-auto-publisher.git
cd geo-auto-publisher
npm install

# 2. Render.com 배포
# - New Web Service > GitHub 연결
# - Build: npm install
# - Start: node src/server.js
# - 환경변수 등록

# 3. 초기 설정
# - [서버URL]/settings 에서 발행 주기/기간/목표 설정
# - 질환 관리에서 토픽 추가
# - 이미지 API 키 등록
# - '테스트 발행'으로 시험
```

## 7. 주요 API 엔드포인트

### 관리자 (ADMIN_PASSWORD 인증)
- `GET /api/status` — 시스템 상태
- `POST /api/publish-now` — 즉시 발행
- `POST /api/test-publish` — 테스트 발행
- `GET /api/contents` — 콘텐츠 목록
- `GET /api/quality-scores` — 품질 점수
- `GET /api/citation-results` — 인용추적
- `GET /api/report` — 월간 리포트

### 클라이언트 (CLIENT_TOKEN 인증)
- `GET /api/client/status` — 발행 현황 (인증 불필요)
- `GET /api/client/contents` — 콘텐츠 목록
- `POST /api/client/contents/:id/reject` — 반려 → 자동 재발행
- `POST /api/client/contents/:id/edit` — 수정 → WP 동기화

## 8. 운영 주의사항

- **WP OAuth 토큰**: 14일마다 갱신 필요 (만료 시 발행 실패)
- **Render 무료 플랜**: 15분 비활동 시 서버 중지 → cron 불가, Starter 플랜 권장
- **WP script 제한**: WordPress.com 호스팅형은 `<script>` 제거 → JSON-LD 직접 삽입 불가
- **이미지 API**: 최소 1개 키 필요, 3개 입력 시 라운드로빈 분산
- **대용량 파일**: server.js (~1800줄), dashboard.html (~2100줄) — 부분 편집 권장
