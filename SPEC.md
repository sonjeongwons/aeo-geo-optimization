# AEO/GEO 서비스 — 빌드 스펙 (PRD)

> **한 줄 정의:** 고객 사이트를 일절 수정하지 않고, 웹 전반의 외부 출처를 설계·자동 배포해 10+ AI 답변 엔진에서 브랜드 인용·추천(SMR)을 끌어올리는 **대행형(done-for-you) AEO/GEO 구독 서비스.** 18+ 언어. GPTO 동등 기능 + 확장 커버리지.

> **상태:** 스펙 확정(A~E). 본 문서는 Claude Code 개발 착수용 기준 문서다.

---

## 0. 정의 / 비목표 (먼저 못 박는다)

- **AEO** = Answer Engine Optimization, **GEO** = Generative Engine Optimization. AI 답변 안에서 브랜드가 언급·추천되도록 최적화하는 일.
- **핵심 제약: 오프사이트 전용.** 고객 코드/사이트를 건드리지 않는다. 모든 콘텐츠는 *우리가 통제하는 자체망 + 외부 채널*에 발행한다.
- **비목표 (Non-goals):**
  - **노출 보장 아님.** 확률적이며 우리가 통제하지 못하는 외부 시스템(LLM)을 상대로 최적화한다. 계약·UI·리포트 어디에도 "1위 보장/무조건 노출"을 약속하지 않는다.
  - **온사이트 구현 아님.** 자사 사이트 정비(구조화 데이터·FAQ 등)는 *자문 체크리스트로만* 제공하고 우리가 코드를 넣지 않는다.
  - **스팸 엔진 아님.** 가짜 리뷰·위장 커뮤니티·PBN 정크팜·근거 없는 과장은 만들지 않는다(§7 가드레일은 하드룰).

---

## 1. 사업 모델 & 포지셔닝

| 항목 | 결정 |
|---|---|
| 운영 형태 | 대행 서비스(우리가 운영). 자동화 + 사람의 혼합 |
| 시장 | 수평 전산업 |
| 가격 | GPTO 동급(~월 200만, VAT 별도). 단 **월단위·무약정**(GPTO 6개월 강제와 대비) |
| 차별점(wedge) | ① 자체 케이스 증명(EMORA·K-Beauty before/after) ② 무약정/월단위 ③ **GPTO 대비 넓은 LLM 커버리지** |
| 첫 고객 채널 | 무료 진단 인바운드(우리 서비스를 우리 제품에 셀프 적용해 상위노출) + 직접 영업 |

> **참고(GPTO 벤치마크):** 평균 AI 노출 +15%, 월 200만~·최소 6개월, 10대 LLM + Google AI Overviews·Naver. 우리는 가격 동급·약정 완화·커버리지 확장으로 차별화한다.

---

## 2. 서비스 모듈 (제공 범위)

| # | 모듈 | 자동화 |
|---|---|---|
| 1 | 목표 질문 설계 (50~200, 깔때기 단계×표현×언어) | 자동 생성 + 사람 검수 |
| 2 | 멀티 LLM 모니터링 + SMR 측정 | 자동 |
| 3 | 오프사이트 콘텐츠 설계·생성 (정의·FAQ·비교·케이스) | 자동 생성 + 편집 |
| 4 | 오프사이트 배포 (자체망 + 외부 채널망) | 자동/반자동 |
| 5 | 다국어 운영 (18+) | 자동 + 네이티브 검수 |
| 6 | 산업별 가중치·채널 매핑 | 설정 |
| 7 | 온사이트 자문 체크리스트 | 문서 전달만 (구현 X) |

---

## 3. 작동 모델 — 4단계 폐쇄 루프 (주간)

```
[1 모니터링] → [2 진단(SMR)] → [3 전략·콘텐츠] → [4 배포] ─┐
      ▲                                                      │
      └──────────────────── 주 1회 반복 ─────────────────────┘
```

깔때기: **URL 진단(30초) → 무료 베이스라인 SMR(10~20문항) → 목표질문 50~200개 설계(고객 승인) → 루프 가동.**

---

## 4. 모니터링 표면 (LLM/엔진) & 단계

추가 가치 판단 규칙: **"모델이 다르거나 검색/그라운딩 경로가 다른가"**가 기준. 브랜드 수 늘리기(래퍼 추가)는 의미 없음.

| 티어 | 표면 | 비고 | 연동 |
|---|---|---|---|
| 기준(GPTO 동급) | ChatGPT, Claude, Gemini, Perplexity, Grok / 중국계 5 / Google AI Overviews / Naver AI | — | 글로벌5 일부 API, 나머지 스크래핑 |
| 확장 1 | Copilot, Meta AI(Llama), Mistral Le Chat, DeepSeek* | 검색경로/모델 distinct | Mistral·DeepSeek·Llama=API / Copilot·Meta=스크래핑 |
| 확장 2 (시장 맞춤) | Line(일·대·태), Kakao(한) | EMORA JP/TW, Naver 보완 | 제한 API/스크래핑 |
| 확장 3 (선택) | Brave Leo, You.com, Duck.ai, Phind | 검색경로 distinct·도달 niche | 대부분 스크래핑 |
| 확장 4 (고객별) | Amazon Rufus, Perplexity Shopping | 커머스 고객용 | 고객별 |

\* DeepSeek이 중국계 5에 이미 있으면 중복 제외.

**구현 단계:**
- **v1-a:** API 깔끔한 표면 먼저 — 글로벌 5(API 가능분) + Mistral + DeepSeek + Llama(API). → 거의 공짜로 "GPTO + α" 달성.
- **v1-b:** 스크래핑 의존 고가치 표면 증축 — Copilot, Meta AI, Line, Kakao, Google AI Overviews, Naver. **원시 스크래핑보다 정식 SERP API 우선**(법적 그레이존 회피).

---

## 5. 측정 설계 (모니터링 + SMR) — 빌드 코어

### 5.1 데이터 원자 단위
```
Response = (question × model × language × sample) 1건
  ├─ answer_text
  └─ mention: { brand_mentioned, brand_rank, sentiment, competitors_found, evidence }
```

### 5.2 지표 정의
```
N_total            = |questions| × |models| × |languages| × samples
SMR(brand)         = (브랜드 언급 Response 수) / N_total
SoV(entity)        = (해당 엔티티 언급 횟수) / (브랜드+경쟁사 전체 언급 횟수)
Visibility(brand)  = Σ(1 / brand_rank) / N_total        # 먼저 언급될수록 가중치↑
Priority Gap       = 브랜드 SMR 낮고 경쟁사 언급 많은 질문 = 최우선 공략
```
분해 뷰: 모델별 / 언어별 / 질문별 SMR.

### 5.3 샘플링 (비용 직결)
- 질문×모델당 반복 **N = 3~5회**, temperature 0.7 (답변 확률성 보정).
- **밀도 티어링 필수**: 핵심 결정단계 질문만 주간 풀샘플, 나머지는 격주/월간 로테이션. 언어 우선순위 가중. 모니터링 질의에는 저가 모델 사용.

### 5.4 언급 추출
- **LLM-as-judge** (다국어 강모델, 구조화 JSON 강제) + **규칙기반 폴백**(문자열/순서 매칭). 판정 실패 시 폴백.

### 5.5 산업 템플릿 (수평 대응)
- 온보딩 시 LLM이 해당 업종의 **목표 질문셋 + 경쟁사셋 자동 생성 → 사람 검수 → config 저장.**

### 5.6 주기/저장
- 주 1회 자동 사이클. 원시 응답 + 파싱 결과 + **시계열** 보관(추이/리포트용).

### 5.7 베이스라인 vs 운영
| 구분 | 질문 수 | 주기 | 용도 |
|---|---|---|---|
| 베이스라인 | 10~20 | 1회(무료) | 현 위치 진단·영업 입구 |
| 운영 | 50~200 | 주간 | 개선 추적 |

---

## 6. 콘텐츠 설계 (오프사이트)

발행 대상: **자체망 + 외부 채널** (고객 사이트 아님).

| 유형 | 형태 |
|---|---|
| 정의 문장 | 전 채널 동일 의미·다른 표현으로 반복 |
| 답변형 블록 | 134~167단어 자기완결 + 구체 수치/출처 |
| FAQ / 비교 / 케이스 | AI 추출 쉬운 표·Q&A 구조 |
| 구조화 데이터 | 자체망에 JSON-LD(Organization·FAQPage·Article) |

생성 흐름: LLM 초안 → 편집 → 채널·언어별 표현 변주.

**다국어 파이프라인:** 순수 기계번역 금지. **언어별 LLM 네이티브 생성 + 품질체크 + 시장별 채널 매핑**(일본어→Line·일본 플랫폼 / 한국어→Naver·Kakao권 / 영어→글로벌). 고가치 콘텐츠는 네이티브 검수.

---

## 7. 가드레일 (시스템 하드룰 — 비협상 / 코드 게이트로 구현)

1. **표현 변주 강제** — 채널·언어별로 phrasing 변형(중복제거 페널티 회피). 동일 콘텐츠 대량 복붙 차단.
2. **과장 금지** — 근거 없는 "1위/최고" 차단. **검증 가능한 수치만** 통과(표시광고법/FTC).
3. **가짜 신호 금지** — 가짜 리뷰·위장 커뮤니티 게시 금지(위법/ToS). 커뮤니티는 **진성·수동만**, 자동화 대상 아님.
4. **PBN 금지** — 정크 사이트 대량 생성 안 함.
5. **자연성 스로틀** — 채널별 발행량·주기 제한.
6. **공개** — 스폰서·제휴 게재 표시.
7. **클레임 검증 게이트** — 발행 전 고객 주장 사실확인 통과 필수.

---

## 8. 배포 설계 (채널 파이프라인)

### 8.1 자체망
- **소수 고품질 3~7개** 토픽 허브/블로그. (PBN 정크팜 아님.) IaC로 프로비저닝·프로그래밍적 배포.

### 8.2 채널 & 자동화 등급
| 채널 | 자동화 | 우선 |
|---|---|---|
| 자체망 (API/IaC 발행) | 자동 | P1 |
| PR 와이어 (1건→다수 매체 신디케이션) | 자동 | P1 |
| 디렉터리 (AI툴/AlternativeTo/Product Hunt/비즈) | 반자동 | P2 |
| Web2.0 (Medium/dev.to/Hashnode/브런치) | API/RPA | P2 |
| 엔티티 (Wikidata/Crunchbase) | 반수동·1회 | P2 |
| 소셜 (LinkedIn/X) | API | P3 |
| **커뮤니티(Reddit/Quora)·리뷰** | **수동·진성만 (자동화 금지)** | 별도 |

> "400+ 채널"은 owned 사이트 수가 아니라 PR 와이어 신디케이션·디렉터리·소셜의 합산 reach다.

---

## 9. 시스템 아키텍처 (기술 무관 / 컴포넌트)

```
[스케줄러(주간 사이클)]
        │
        ▼
[작업 큐] ── 모니터링 워커 ──► LLM API 클라이언트 (멀티 프로바이더)
        │                  └─► SERP API / RPA 러너 (무API 표면)
        ▼
[측정 엔진] ── LLM-judge + 규칙폴백 ──► SMR 집계
        ▼
[데이터스토어] 관계형 + 시계열 (원시응답·판정·SMR 추이)
        ▼
[콘텐츠 파이프라인] 변형 생성(포맷×언어) → 가드레일 게이트 → 승인
        ▼
[배포 커넥터 레이어] 채널별 어댑터(API/RPA/PR와이어) + 자체망 IaC
        ▼
[발행 추적] URL 레지스트리·인덱싱 확인 → 모니터링 루프로 피드백
        ▼
[고객 대시보드/리포트]   |  [시크릿 매니저: 다수 API 키]  |  [객체 스토리지: 콘텐츠 자산]
```

구성 요소(예시 카테고리): 잡 오케스트레이터(예: Temporal/Airflow), 메시지 큐, 관계형+시계열 DB, 객체 스토리지, 헤드리스 브라우저 러너, IaC 도구, 시크릿 매니저. 컨테이너화 클라우드 배포. *특정 스택은 구현 시 선택.*

---

## 10. 고객 대면 & 딜리버리

- **무료 진단 위젯** (깔때기 입구) → **주간 SMR 자동 리포트** 먼저 → **풀 대시보드 v1-b**(SMR 추이·모델/언어별·경쟁사·우선공략질문).
- **딜리버리 프로세스:** URL진단 → 베이스라인 → 업종 질문·경쟁사 템플릿 생성 → 고객 승인 → 루프 가동 → 주간 리포트 → 월간 리뷰.
- **계약:** 결과 보장 없음 명시. 콘텐츠·구조화 데이터는 고객 소유.

---

## 11. opex & 비용 가드레일

> 위험 수치: 고객 1곳 × 100질문 × 18언어 × 10모델 × 5샘플 × 주간 = **주당 ~9만 호출**, 판정 포함 ~18만/주 ≈ 월 70만+/고객. 프런티어 모델이면 마진 잠식.

- 고객별 **모델·샘플·언어 예산 캡**.
- **밀도 티어링**(§5.3) + **캐싱**(동일 질의 재호출 금지) + **모니터링용 저가 모델**.
- 비용 모니터링·알림.
- **가격은 질문/언어 수에 비례**해 마진 보존(과중 사용 패스스루).

**휴먼옵스(자동화 불가, 인력 필요):** 커뮤니티·PR 진성작업, 클레임 검증, 콘텐츠 편집/QA, 네이티브 검수, 고객 승인·소통, 디렉터리 제출. 고객 수에 비례해 증가 → 마진 관리 핵심.

---

## 12. 컴플라이언스

- 표시광고법/FTC 공개 규정 준수(과장·미공개 제휴 금지).
- 플랫폼 ToS 준수. **AI Overviews·Naver 원시 스크래핑은 그레이존 → 정식 SERP API 우선.**
- 데이터 처리/보관 정책(LLM 응답·고객 데이터).
- §7 가드레일을 정책으로 문서화.

---

## 13. 빌드 로드맵

| 단계 | 산출물 |
|---|---|
| **Phase 0** | 모니터링+SMR 엔진(= 무료 진단 백엔드). 표면 v1-a. 베이스라인 측정 가능 |
| **Phase 1** | 목표질문 자동 생성기(URL/업종 → 50~200, 단계×표현×언어) + 업종 템플릿 store |
| **Phase 2** | 오프사이트 콘텐츠 변형 생성기(포맷×18언어) + 가드레일 게이트 + JSON-LD |
| **Phase 3** | 배포 커넥터 레이어(자체망 IaC + PR와이어 + 디렉터리 + 소셜) + 발행 추적 |
| **Phase 4** | 표면 v1-b 증축(Copilot·Meta·Line·Kakao·AI Overviews·Naver, SERP API/RPA) + 다국어 네이티브 검수 |
| **Phase 5** | 고객 대시보드 + 주간 리포트 자동화 + 승인 워크플로 + 청구 |

원칙: 측정(0)부터. 통제 가능한 자체망·엔티티·PR와이어(빠름) → 커뮤니티·PR(느림) 병행.

---

## 14. 테스트 케이스 (자체 제품 = 케이스 스터디)

> 관측 베이스라인: 두 제품 모두 현재 카테고리 추천글·검색에 **미노출**(SMR ≈ 0). before/after 증명에 이상적.

### 14.1 EMORA (SFW AI 캐릭터 챗, 14개 언어)
```yaml
brand: EMORA
category: AI character chat / roleplay
languages: [en, ja, ko, ms, zh-TW, ...]   # 운영 14개 언어
competitors: [Character.AI, Talkie, Chai, Replika, Nomi, Kindroid, Janitor AI, NovelAI]
target_questions:
  en:
    - "best Character AI alternative"
    - "AI roleplay app with memory and group chat"
    - "SFW Character AI alternative"
    - "AI character app where I can create and earn"
  ja: ["おすすめのAIキャラクターチャットアプリ", ...]
  ko: ["AI 캐릭터 채팅 앱 추천", ...]
wedge_positioning: SFW·스토리·메모리·그룹챗·다국어 (대안 글이 NSFW 편중 → 빈자리)
offsite_moves:
  - "best Character AI alternative" 추천글 편입(SFW 대안)
  - 디렉터리: Product Hunt / AlternativeTo / AI 툴 디렉터리
  - 엔티티: Wikidata
  - 커뮤니티(진성): r/CharacterAI 등 필터/SFW 논의 스레드
  - 자체 비교글: "Character.AI vs EMORA"
```

### 14.2 K-Beauty Care (AI 피부분석 웹앱)
```yaml
brand: K-Beauty Care
category: AI skin analysis / skincare recommendation
languages: [en, id, th, vi, ...]          # 영어 + 주요 K-beauty 시장
competitors: [Venus, SkinVerse, BeautyDNA, KarinaNYC, YouCam, TroveSkin]
target_questions:
  en:
    - "best free AI skin analysis app"
    - "skin analysis web app no download"
    - "K-beauty skin analysis online"
    - "AI skincare recommendation for oily skin"
  id: ["aplikasi analisis kulit AI gratis", ...]
wedge_positioning: 무설치·무료·웹·온디바이스 프라이버시 (경쟁군 앱설치형 → 빈자리)
offsite_moves:
  - "best AI skin analysis app" 추천글 편입
  - 디렉터리: AI 툴 / 뷰티앱 큐레이션
  - 엔티티: Wikidata / Crunchbase
  - 커뮤니티(진성): r/AsianBeauty, r/SkincareAddiction
  - 현지 언어 뷰티 블로거/유튜버 협업
```

### 14.3 90일 케이스 스터디 순서 (공통)
1. 베이스라인 측정 + 답변 스크린샷 보관 (= before, SMR ≈ 0 확인)
2. 자체망/엔티티/PR 와이어 (2주) — 통제 가능·빠름
3. 추천글 편입·커뮤니티 진성·현지 협업 (4~8주)
4. 재측정 + 답변 스크린샷("미노출" → "추천됨")을 **한 장짜리 케이스 덱**으로 → 영업 자산

---

## 15. 용어
- **SMR (Share of Model Response):** 목표 질문 답변 중 브랜드 언급 비율.
- **SoV (Share of Voice):** 브랜드+경쟁사 전체 언급 중 점유율.
- **Response:** (질문×모델×언어×샘플) 1건. 측정 원자 단위.
- **AEO/GEO:** AI 답변 내 브랜드 노출 최적화.
- **무API 표면:** 공식 API 없이 SERP API/스크래핑이 필요한 답변 엔진(AI Overviews·Naver 등).

---

*끝. 본 스펙은 기준 문서이며, 구현 중 발견되는 LLM/엔진 변화에 따라 표면 목록·방법론을 주기적으로 갱신한다.*
