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
    description: '화접몽한의원 강남본점 원장. 2007년 개원, 피부질환 한방치료 전문. 2014년 『동의보감으로 말하다』 저술, 2015년 복합 여드름흉터 치료법 ‘리셀테라피’ 개발, 2011년 한방성형학회 부회장, MBC·KBS·SBS 등 다수 방송 출연 및 자문.',
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
    subtopics: ['좁쌀여드름 구분', '검버섯 구분', '점 구분', '비립종 구분', '쥐젖 구분', '물사마귀 차이', '전염', '원인·HPV', '면역력 저하', '방치 시 번짐', '재발', '레이저 치료', '냉동치료 비교', '자연치유 여부', '연고 치료', '목·손등', '얼굴', '청소년·젊은층', '제거 후 색소침착 관리', '거우침'],
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
    subtopics: ['팔뚝', '허벅지·다리', '등', '얼굴 홍조', '각질 제거', '유전', '건조·겨울', '보습관리', '성인', '청소년', '색소침착', '뱀살', '완치 여부', '뜯는 습관', '레이저 치료', 'AHA·BHA 성분', '아토피 연관', '여드름 구분', '화안케어'],
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
    subtopics: ['두피 모낭염', '등', '얼굴', '다리 면도 후', '엉덩이', '겨드랑이·왁싱 후', '재발', '세균성·진균성 구분', '말라세지아 모낭염', '곰팡이성 여드름', '여드름 구분', '땀·마스크', '압출 주의', '항생제·연고 한계', '흉터 여부', '가려움', '원인', '발효약초테라피'],
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
    subtopics: ['이마', '볼', '입주변', '턱드름', '호르몬', '생리주기', '스트레스', '압출', '흉터 예방', '자국·색소침착', '화장품', '마스크 트러블', '좁쌀여드름', '화농성 여드름', '성인여드름', '블랙헤드·화이트헤드', '결절·낭포성', '등여드름', '여드름약(이소트레티노인)', '여드름 흉터', '화안케어'],
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
    subtopics: ['성인 아토피', '소아 아토피', '아기·신생아 아토피', '얼굴', '목', '팔오금', '손 습진', '태선화', '진물', '밤 가려움', '건조·각질', '보습', '스테로이드 연고', '재발', '원인', '유전', '좋은 음식', '환절기·겨울 관리', '한약치료'],
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
    subtopics: ['패인흉터', '붉은자국', '갈색 색소침착', '송곳형', '박스형', '롤링형', '모공흉터', '볼·턱 흉터', '자연회복 여부', '초기 관리', '오래된 흉터', '흉터 연고', '서브시전', '레이저 치료', 'TCA 크로스', '없애는 법', '자외선 차단', '화장품 커버', '리셀테라피'],
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
    subtopics: ['판상건선', '물방울건선', '농포건선', '두피 건선', '손발톱 건선', '손발바닥 건선', '팔꿈치', '무릎', '건선 관절염', '인설·각질', '초기증상', '원인·자가면역', '스트레스', '겨울·계절 악화', '재발', '지루성피부염 구분', '좋은 음식', '생활관리·보습', '완치·전염 여부', '한약 처방'],
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
    subtopics: ['손가락', '손바닥', '발바닥', '물집', '각질 벗겨짐', '갈라짐·균열', '손톱 변화', '가려움', '원인', '재발', '만성화', '여름·계절 악화', '스트레스', '다한증', '주부습진 구분', '무좀 구분', '금속알레르기', '발효약초테라피'],
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
    subtopics: ['다이어트 한약', '체질별 처방', '복부비만', '산후비만', '갱년기 비만', '폭식', '식욕억제', '요요 방지', '붓기·부종', '대사', '정체기 극복', '운동 병행', '하체비만·셀룰라이트', '부작용·안전성', '다이어트약 비교', '40대 다이어트'],
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
    subtopics: ['두피 지루성피부염', '이마·눈썹', '콧볼 홍반', '얼굴', '비듬', '각질', '홍반', '가려움', '만성 재발', '계절성 악화', '스트레스', '아토피 구분', '건선 구분', '여드름 구분', '약용샴푸 관리', '말라세지아균 원인', '화안케어'],
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
    subtopics: ['정강이 오돌토돌 돌기', '종아리 갈색 색소침착', '등 색소침착', '적갈색 구진', '만성 가려움', '긁는 습관', '태선화', '태선양형', '반점상형', '마찰 원인', '모공각화증 구분', '만성단순태선 구분', '아토피 구분', '각질', '다리 색소침착 치료', '거우침'],
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
