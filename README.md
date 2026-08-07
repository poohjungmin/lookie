# LOOKIE (룩기)

사진첩에 쌓여 있는 거울셀카를 자동으로 정리해 개인 룩 히스토리를 만들고,
과거 촬영 당시의 날씨를 함께 보여주는 개인용 웹앱입니다.

핵심 원칙은 "사용자가 직접 입력하는 것을 최대한 없애는 것" — 사진만 선택하면
촬영 날짜, GPS 위치, 그 당시의 날씨까지 자동으로 채워집니다.

현재는 초기 단계(STEP 1~2)로, 사진 메타데이터 추출과 과거 날씨 조회 기술 검증까지
구현되어 있습니다. Firebase 저장, 로그인, Vision AI 분석은 아직 연결되지 않았습니다.

## 핵심 기능

- 거울셀카 여러 장 동시 선택 (HEIC/JPEG 등 iPhone 사진 지원)
- 선택한 사진의 미리보기 표시
- EXIF에서 촬영 날짜/시간, GPS 위도·경도 자동 추출
- 촬영 날짜 + GPS로 해당 날짜/위치의 과거 날씨 자동 조회 (최고·최저기온, 강수량, 날씨 상태 등)
- 메타데이터/날씨가 없거나 조회에 실패해도 사진 자체는 항상 정상 표시
- 동일 날짜·인근 좌표의 사진은 날씨 API를 중복 호출하지 않음 (메모리 캐시)
- 모든 처리는 브라우저 메모리에서만 이루어지며, 서버/클라우드에 저장하지 않음

## 기술 스택

- [Next.js](https://nextjs.org) (App Router) + TypeScript
- [Tailwind CSS](https://tailwindcss.com)
- [exifr](https://github.com/MikeKovarik/exifr) — 브라우저 EXIF 파싱 (무료 오픈소스)
- [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) — 과거 날씨 조회 (무료, API Key 불필요)
- (예정) Firebase Authentication / Firestore / Storage

## 실행 방법

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 접속.

같은 Wi-Fi의 다른 기기(예: iPhone)에서 테스트하려면 터미널에 출력되는
`Network: http://<사설 IP>:3000` 주소로 접속하세요.
