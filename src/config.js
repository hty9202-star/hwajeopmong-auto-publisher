/**
 * 화접몽 한의원 GEO Auto-Publisher 설정
 *
 * 질환 추가 방법: TOPICS 배열에 새 객체를 추가하면 자동으로 로테이션에 포함됩니다.
 * 콘텐츠 유형은 CONTENT_TYPES에서 관리합니다.
 */

// ─── 브랜드 정보 ───
export const BRAND = {
  name: '화접몽 한의원',
  nameEn: 'Hwajeopmong Korean Medicine Clinic',
  specialty: '피부질환 전문 한방 클리닉',
  tone: '전문적이고 신뢰감 있으며, 환자를 배려하는 따뜻한 어조',
  url: 'https://www.mongclinic.com',
  phone: '0507-1423-7587',
  address: '서울특별시 강남구 강남대로84길 8 우인빌딩 9층',
  doctor: {
    name: '오철',
    title: '화접몽한의원 강남본점 원장',
    specialty: '피부과 전문',
    image: 'https://mongclinic.blog/wp-content/uploads/2026/05/20260529_172954.png',
    // E-E-A-T 저자 권위 신호 (Person/Physician 스키마용)
    description: '화접몽한의원 강남본점 원장. 한의사이자 한의학 박사(2008년 세명대학교 대학원). 2007년 개원, 피부질환 한방치료 전문. 2014년 『동의보감으로 말하다』 저술, 2015년 복합 여드름흉터 치료법 ‘리셀테라피’ 개발, 2011년 한방성형학회 부회장, MBC·KBS·SBS 등 다수 방송 출연 및 자문.',
    credential: '한의학 박사',
    profileUrl: 'https://mongclinic.blog/',   // 블로그 저자 소개(의료진 소개) 위치
    // 동일 인물을 가리키는 외부 권위 출처
    sameAs: [
      'https://www.mongclinic.com/index.php/html/3', // 본사 화접몽 소개
    ],
  },
  // ─── 공식 채널 (sameAs: 엔티티 동일성 신호 / GEO·지식그래프) ───
  sameAs: [
    'https://map.naver.com/p/entry/place/19838331', // 네이버 플레이스
    'https://cafe.naver.com/mongclinic',            // 네이버 카페
    'https://www.instagram.com/mongclinic_gangnam', // 인스타그램
    'https://www.youtube.com/@TV-ul7fv',            // 유튜브
  ],
  // ─── 지점/지역 정보 (강남본점 전용 — 지역 GEO 신호) ───
  branchName: '강남본점',
  addressRegion: '서울특별시',
  addressLocality: '강남구',
  areaServed: ['서울 강남구', '강남역', '역삼동', '서초구', '서울특별시'],
  // 역삼동 826-4 / 강남대로84길 8 — 네이버 플레이스 기준 정확 좌표
  geo: { lat: 37.4964810, lng: 127.0293382 },
  // 본사(네트워크) — branchOf로 연결해 권위 상속
  parentOrg: {
    name: '화접몽한의원 네트워크',
    url: 'https://www.mongclinic.com',
  },
};

// ─── AI 모델 설정 (Google Gemini - 유료) ───
export const AI_CONFIG = {
  provider: 'gemini',
  model: 'gemini-3.5-flash',        // Gemini 3.5 Flash (정식) - 품질 업그레이드. 실패 시 2.5-flash로 폴백
  maxTokens: 8192,
  temperature: 0.7,                 // v2.1: 콘텐츠 다양성 확보 (단계별 차등: 0.6/0.7/0.85)
  apiBase: 'https://generativelanguage.googleapis.com/v1beta',
};

// ─── 발행 설정 ───
export const PUBLISH_CONFIG = {
  postsPerSlot: 1,       // 슬롯당 1개 (품질 중심)
  slotsPerDay: 5,        // 하루 5슬롯 (09:00, 11:00, 13:00, 15:00, 17:00 KST)
  defaultStatus: 'publish', // 'draft' 또는 'publish'
  defaultCategory: '피부질환',
};

// ─── 콘텐츠 유형 (5종) ───
export const CONTENT_TYPES = [
  {
    id: 'comprehensive-guide',
    name: '종합 가이드',
    titlePattern: '{disease}란? 원인·증상·치료법 완벽 가이드',
    description: '질환의 전체적인 개요를 다루는 1차 소스 콘텐츠',
    priority: 1, // 가장 먼저 생성
  },
  {
    id: 'korean-medicine-treatment',
    name: '한방 치료법',
    titlePattern: '{disease} 한방 치료 – 화접몽 한의원의 접근법',
    description: '화접몽 한의원의 치료 방법을 상세히 설명하는 브랜드 콘텐츠',
    priority: 2,
  },
  {
    id: 'faq',
    name: 'FAQ',
    titlePattern: '{disease} 자주 묻는 질문 10가지',
    description: 'FAQPage 스키마로 AI 직접 인용을 유도하는 Q&A 콘텐츠',
    priority: 3,
  },
  {
    id: 'case-study',
    name: '치료 사례',
    titlePattern: '{disease} 한방 치료 경과 사례 – 화접몽 한의원',
    description: '치료 경험(Experience) 신호를 강화하는 사례 콘텐츠',
    priority: 4,
  },
  {
    id: 'comparison',
    name: '치료 방법 안내',
    titlePattern: '{disease} 다양한 치료 방법과 한방 접근법 안내',
    description: '다양한 치료 옵션을 안내하고 한방 치료의 특징을 설명하는 콘텐츠 (의료법 준수: 비교 광고 금지)',
    priority: 5,
  },
];

// ─── 질환 토픽 목록 (확장 가능) ───
// 새 질환 추가 시 이 배열에 객체를 추가하면 됩니다.
export const TOPICS = [
  {
    id: 'flat-warts',
    name: '편평사마귀',
    nameEn: 'Flat Warts',
    slug: 'flat-warts',
    category: '피부질환',
    keywords: ['편평사마귀 한방치료', '편평사마귀 원인', '편평사마귀 한의원', '편평사마귀 치료기간'],
    medicalName: 'Verruca Plana',
    icd10: 'B07.8',
    pexelsQuery: 'skin care dermatology',
    description: 'HPV(인유두종바이러스)에 의해 발생하는 편평한 형태의 사마귀',
    relatedTopics: ['keratosis-pilaris', 'folliculitis'],
  },
  {
    id: 'keratosis-pilaris',
    name: '모공각화증',
    nameEn: 'Keratosis Pilaris',
    slug: 'keratosis-pilaris',
    category: '피부질환',
    keywords: ['모공각화증 치료', '닭살피부 한방', '모공각화증 한의원', '팔 닭살피부'],
    medicalName: 'Keratosis Pilaris',
    icd10: 'L85.8',
    pexelsQuery: 'skin texture smooth',
    description: '모낭 주위에 각질이 쌓여 닭살처럼 돌기가 생기는 피부 질환',
    subtopics: ['매몰모형', '호르몬민감형', '홍반형', '다리 모공각화증', '팔 모공각화증', '착색'],
    relatedTopics: ['flat-warts', 'folliculitis', 'atopic-dermatitis'],
  },
  {
    id: 'folliculitis',
    name: '모낭염',
    nameEn: 'Folliculitis',
    slug: 'folliculitis',
    category: '피부질환',
    keywords: ['모낭염 한방치료', '두피모낭염', '모낭염 한의원', '등 모낭염'],
    medicalName: 'Folliculitis',
    icd10: 'L73.9',
    pexelsQuery: 'skin health care',
    description: '모낭(털주머니)에 염증이 생기는 피부 감염 질환',
    relatedTopics: ['acne', 'seborrheic-dermatitis'],
  },
  {
    id: 'acne',
    name: '여드름',
    nameEn: 'Acne',
    slug: 'acne',
    category: '피부질환',
    keywords: ['여드름 한방치료', '성인여드름 한의원', '여드름 한방', '턱여드름 원인'],
    medicalName: 'Acne Vulgaris',
    icd10: 'L70.0',
    pexelsQuery: 'clear skin face care',
    description: '피지선의 과다 분비와 모공 막힘으로 발생하는 염증성 피부 질환',
    relatedTopics: ['acne-scars', 'folliculitis', 'seborrheic-dermatitis'],
  },
  {
    id: 'atopic-dermatitis',
    name: '아토피',
    nameEn: 'Atopic Dermatitis',
    slug: 'atopic-dermatitis',
    category: '피부질환',
    keywords: ['아토피 한방치료', '아토피 한의원', '아토피 피부염 한방', '소아아토피'],
    medicalName: 'Atopic Dermatitis',
    icd10: 'L20',
    pexelsQuery: 'skin care natural remedy',
    description: '만성적으로 재발하는 가려움증과 습진을 동반하는 피부 질환',
    relatedTopics: ['seborrheic-dermatitis', 'dyshidrosis', 'psoriasis'],
  },
  {
    id: 'acne-scars',
    name: '여드름흉터',
    nameEn: 'Acne Scars',
    slug: 'acne-scars',
    category: '피부질환',
    keywords: ['여드름흉터 한방', '여드름자국 치료', '여드름흉터 한의원', '패인흉터 한방치료'],
    medicalName: 'Acne Scar',
    icd10: 'L90.5',
    pexelsQuery: 'skin recovery healing',
    description: '여드름 염증 후 남은 흉터 및 색소 침착',
    relatedTopics: ['acne', 'folliculitis'],
  },
  {
    id: 'psoriasis',
    name: '건선',
    nameEn: 'Psoriasis',
    slug: 'psoriasis',
    category: '피부질환',
    keywords: ['건선 한방치료', '건선 한의원', '두피건선', '건선 자연치유'],
    medicalName: 'Psoriasis',
    icd10: 'L40',
    pexelsQuery: 'skin health dermatology',
    description: '피부 세포가 비정상적으로 빠르게 증식하여 은백색 비늘이 생기는 만성 피부 질환',
    relatedTopics: ['atopic-dermatitis', 'seborrheic-dermatitis'],
  },
  {
    id: 'dyshidrosis',
    name: '한포진',
    nameEn: 'Dyshidrotic Eczema',
    slug: 'dyshidrosis',
    category: '피부질환',
    keywords: ['한포진 한방치료', '손 물집 한의원', '한포진 원인', '발바닥 한포진'],
    medicalName: 'Dyshidrotic Eczema',
    icd10: 'L30.1',
    pexelsQuery: 'hand care skin',
    description: '손바닥, 손가락, 발바닥에 작은 물집이 생기는 습진성 피부 질환',
    relatedTopics: ['atopic-dermatitis', 'psoriasis'],
  },
  {
    id: 'diet',
    name: '다이어트',
    nameEn: 'Weight Management',
    slug: 'diet',
    category: '체형관리',
    keywords: ['한방다이어트', '한의원 다이어트', '한방 체중감량', '다이어트 한약'],
    medicalName: 'Obesity Management',
    icd10: 'E66',
    pexelsQuery: 'healthy lifestyle wellness',
    description: '한의학적 체질 진단을 기반으로 한 맞춤형 체중 관리 프로그램',
  },
  {
    id: 'seborrheic-dermatitis',
    name: '지루성피부염',
    nameEn: 'Seborrheic Dermatitis',
    slug: 'seborrheic-dermatitis',
    category: '피부질환',
    keywords: ['지루성피부염 한방', '두피 지루성피부염', '지루성피부염 한의원', '얼굴 지루성피부염'],
    medicalName: 'Seborrheic Dermatitis',
    icd10: 'L21',
    pexelsQuery: 'scalp care healthy hair',
    description: '피지 분비가 많은 부위에 발생하는 만성 염증성 피부 질환',
    relatedTopics: ['acne', 'folliculitis', 'atopic-dermatitis'],
  },
  {
    id: 'cutaneous-amyloidosis',
    name: '피부아밀로이드증',
    nameEn: 'Cutaneous Amyloidosis',
    slug: 'cutaneous-amyloidosis',
    category: '피부질환',
    keywords: ['피부아밀로이드증 한방치료', '강남 피부아밀로이드증', '강남역 피부아밀로이드증', '피부아밀로이드증 한의원'],
    medicalName: 'Amyloidosis Cutis',
    icd10: 'L99.0',
    pexelsQuery: 'skin care dermatology',
    description: '아밀로이드 단백질이 피부에 침착되어 색소침착·돌기·만성 가려움증을 일으키는 피부 질환',
    subtopics: ['색소침착', '만성습진', '각질형성세포'],
    relatedTopics: ['atopic-dermatitis', 'dyshidrosis', 'keratosis-pilaris'],
  },
];

// ─── WordPress 카테고리 매핑 ───
export const WP_CATEGORIES = {
  '피부질환': { slug: 'skin-disease', description: '피부질환 한방 치료 정보' },
  '체형관리': { slug: 'body-care', description: '한방 다이어트 및 체형 관리' },
  '한의학 정보': { slug: 'korean-medicine', description: '한의학 일반 정보' },
};

// ─── Pexels 이미지 설정 ───
export const IMAGE_CONFIG = {
  heroSize: 'large',      // Pexels 이미지 사이즈
  inlineCount: 2,         // 본문 내 삽입 이미지 수
  orientation: 'landscape',
};

// ─── 토픽 로테이션 헬퍼 ───
export function getNextTopic(publishedTopicIds = []) {
  // 모든 질환 × 콘텐츠 유형 조합 생성
  const allCombinations = [];
  for (const topic of TOPICS) {
    for (const type of CONTENT_TYPES.sort((a, b) => a.priority - b.priority)) {
      const comboId = `${topic.id}__${type.id}`;
      if (!publishedTopicIds.includes(comboId)) {
        allCombinations.push({ topic, contentType: type, comboId });
      }
    }
  }

  if (allCombinations.length === 0) {
    // 모든 조합이 발행됨 → 가장 오래된 것부터 재발행
    return {
      topic: TOPICS[0],
      contentType: CONTENT_TYPES[0],
      comboId: `${TOPICS[0].id}__${CONTENT_TYPES[0].id}`,
      isRepublish: true,
    };
  }

  return { ...allCombinations[0], isRepublish: false };
}
