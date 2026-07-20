# 홈페이지 MedicalClinic 스키마 (붙여넣기용)

홈에 병원(MedicalClinic) 스키마가 빠져 있어서 추가하는 코드입니다.
아래 `<script>` 블록 전체를 복사해서 워드프레스 홈페이지 편집 화면의 **커스텀 HTML 블록**에 붙여넣으세요.

## 넣는 방법
1. 워드프레스 관리자 → 홈페이지(front page) 편집
2. 블록 추가(+) → **커스텀 HTML** 블록 선택
3. 아래 코드 전체를 붙여넣기
4. 업데이트/저장
5. 확인: https://search.google.com/test/rich-results 에 `https://mongclinic.blog/` 넣어 MedicalClinic이 감지되는지 확인

> ⚠️ 우편번호(postalCode)는 실제 값으로 채워 넣으세요. 아래엔 06232로 넣어뒀는데, 정확한 우편번호가 다르면 수정하세요. (틀린 우편번호는 오히려 해로우니 확실하지 않으면 그 줄을 지워도 됩니다.)

## 붙여넣을 코드

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MedicalClinic",
  "@id": "https://mongclinic.blog/#medicalclinic",
  "name": "화접몽한의원 강남본점",
  "alternateName": "화접몽 한의원",
  "description": "피부질환 한방치료 전문 한의원. 편평사마귀, 모공각화증, 아토피, 건선, 여드름, 여드름흉터, 모낭염, 지루성피부염, 한포진 등 체질 맞춤 1:1 한방치료. 2007년 개원, 오철 원장 직접 진료.",
  "url": "https://mongclinic.blog/",
  "telephone": "+82-2-545-7579",
  "image": "https://mongclinic.blog/wp-content/uploads/2026/05/20260529_171908.png",
  "logo": "https://mongclinic.blog/wp-content/uploads/2026/05/cropped-mongclinic_logo_header.png",
  "medicalSpecialty": "Dermatology",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "강남대로84길 8 우인빌딩 9층",
    "addressLocality": "강남구",
    "addressRegion": "서울특별시",
    "postalCode": "06232",
    "addressCountry": "KR"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 37.4964810,
    "longitude": 127.0293382
  },
  "hasMap": "https://map.naver.com/p/entry/place/19838331",
  "areaServed": [
    { "@type": "Place", "name": "강남구" },
    { "@type": "Place", "name": "강남역" },
    { "@type": "Place", "name": "역삼동" },
    { "@type": "Place", "name": "서초구" }
  ],
  "openingHoursSpecification": [
    { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Friday"], "opens": "11:30", "closes": "21:00" },
    { "@type": "OpeningHoursSpecification", "dayOfWeek": "Saturday", "opens": "11:00", "closes": "17:00" }
  ],
  "availableService": [
    { "@type": "MedicalProcedure", "name": "편평사마귀 한방치료" },
    { "@type": "MedicalProcedure", "name": "모공각화증 화안케어" },
    { "@type": "MedicalProcedure", "name": "아토피 한방치료" },
    { "@type": "MedicalProcedure", "name": "건선 한방치료" },
    { "@type": "MedicalProcedure", "name": "여드름 한방치료" },
    { "@type": "MedicalProcedure", "name": "여드름흉터 리셀테라피" },
    { "@type": "MedicalProcedure", "name": "모낭염 한방치료" },
    { "@type": "MedicalProcedure", "name": "지루성피부염 한방치료" }
  ],
  "physician": {
    "@type": "Physician",
    "@id": "https://mongclinic.blog/#physician",
    "name": "오철",
    "jobTitle": "화접몽한의원 강남본점 원장",
    "image": "https://mongclinic.blog/wp-content/uploads/2026/05/20260529_172954.png",
    "medicalSpecialty": "Dermatology",
    "description": "화접몽한의원 강남본점 원장. 한의사이자 한의학 박사(2008년 세명대학교 대학원). 2007년 개원, 피부질환 한방치료 전문. 2015년 복합 여드름흉터 치료법 '리셀테라피' 개발, 2011년 한방성형학회 부회장, 방송 다수 출연.",
    "url": "https://mongclinic.blog/"
  },
  "parentOrganization": {
    "@type": "Organization",
    "name": "화접몽한의원 네트워크",
    "url": "https://www.mongclinic.com"
  },
  "sameAs": [
    "https://www.mongclinic.com",
    "https://map.naver.com/p/entry/place/19838331",
    "https://cafe.naver.com/mongclinic",
    "https://www.instagram.com/mongclinic_gangnam",
    "https://www.youtube.com/@TV-ul7fv"
  ]
}
</script>
```

## 포함된 내용
- 병원명·설명·전화(02-545-7579)·주소·정확 좌표(네이버 플레이스 기준)
- 진료과목: Dermatology(피부)
- 진료시간(월화수금 11:30–21:00 / 토 11:00–17:00)
- 제공 진료: 편평사마귀·모공각화증·아토피·건선·여드름·여드름흉터·모낭염·지루성피부염
- 오철 원장(Physician) — 직함·사진·박사·리셀테라피
- 상위조직(화접몽 네트워크) + sameAs(네이버 플레이스·카페·인스타·유튜브·본사)
