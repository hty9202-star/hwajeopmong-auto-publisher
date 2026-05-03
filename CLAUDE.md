# 화접몽 GEO Auto-Publisher — 프로젝트 메모리

## 프로젝트 경로 (절대 변경 금지)

**작업 경로: `C:\project\hwajeopmong-auto-publisher`**

- 이전 경로 `C:\Users\7dayis-240829\Desktop\hwajeopmong-auto-publisher`는 폐기됨
- - 모든 파일 읽기/쓰기/편집은 반드시 `C:\project\hwajeopmong-auto-publisher` 기준
  - - bash에서는 `/sessions/dazzling-vigilant-albattani/mnt/hwajeopmong-auto-publisher/`
   
    - ## 핵심 파일 구조
   
    - ```
      C:\project\hwajeopmong-auto-publisher\
      ├── package.json
      ├── wrangler.toml
      ├── .gitignore
      ├── README.md
      ├── CLAUDE.md          ← 이 파일
      ├── src/
      │   ├── server.js              # 메인 서버 (Node.js + Supabase)
      │   ├── dashboard.html         # 관리자 대시보드
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

      ## 주의사항

      - 파일 수정 시 전체 파일을 덮어쓰지 말 것 (Edit 도구로 부분 수정)
      - - dashboard.html은 ~2072줄로 큰 파일 — 반드시 부분 읽기/편집
        - - server.js는 ~1391줄 — 마찬가지로 부분 편집 권장
          - - content-generator.js도 대형 파일 — 잘림 주의
           
            - ## 실수 방지
           
            - - 경로를 Desktop으로 되돌리지 않기
              - - 파일 Write 시 기존 내용 유실 방지 (Read 먼저)
                - - 큰 파일은 한 번에 Write하지 않기
                  - 
