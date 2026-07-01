# EMORA 경쟁사 검증 사실 리서치 — Claude Code 작업 지시서

> 이 문서를 **EMORA 프로젝트의 Claude Code**에 그대로 붙여넣어 작업을 요청하세요.
> 결과물(`emora-competitor-facts.json`)을 AEO/GEO 담당에게 전달하면, 비교/대안 페이지(`EMORA vs Character.AI`, `best Character.AI alternatives` 등)를 §7 정직 게이트를 통과시켜 발행합니다.
> 비교/대안 페이지는 ChatGPT 인용의 약 51%를 차지하는 최고 레버입니다.

---

## 0. 너의 역할과 목표 (Claude Code에게)

너는 **EMORA의 경쟁 분석 리서처**다. 목표는 EMORA와 8개 경쟁사를 정해진 비교 항목에서 **공개·검증 가능한 사실 + 출처 URL**로 정리한 `emora-competitor-facts.json` 파일 1개를 만드는 것이다.

이 데이터는 **AI 답변엔진 최적화(AEO/GEO)** 비교 페이지의 사실 근거(claim source)로 쓰인다. 따라서 **모든 사실은 출처가 있어야 하고, 출처 없는 추측은 절대 금지**다.

---

## 1. 절대 규칙 (HARD RULES — 어기면 데이터 폐기)

1. **출처 필수**: 경쟁사에 대한 모든 사실은 **공개 URL 출처 1개 이상 + 그 출처의 원문 인용(quote) + 확인 날짜**가 있어야 한다.
2. **추측 금지**: 출처를 못 찾으면 그 항목은 `"value": "unknown"` 으로 표기한다. **추정·일반상식·기억에 의존한 값 입력 금지.** 모르면 unknown.
3. **공개·합법 출처만**: 경쟁사 공식 사이트, 요금 페이지, 도움말/FAQ, 앱스토어(App Store/Google Play) 설명, 공식 블로그/프레스, Wikipedia, 신뢰할 만한 보도. **로그인 뒤 비공개 정보·ToS 위반 스크래핑·사적 데이터 금지.**
4. **중립·사실 서술**: 비방·과장·주관적 평가 금지. "더 나쁘다/별로다" 같은 표현 금지. **검증 가능한 사실만 중립적으로.** (예: ❌ "Character.AI는 기억력이 형편없다" → ✅ "Character.AI는 세션 간 영구 장기기억을 기본 제공하지 않는다 [출처]")
5. **날짜 스탬프**: 요금·기능은 자주 바뀐다. 모든 값에 `date_checked`(YYYY-MM-DD)를 넣는다.
6. **변동·조건 명시**: "무료 티어 기준", "지역에 따라 다름", "2026년 6월 기준" 같은 단서를 `notes`에 적는다.
7. **EMORA 값도 출처와 함께**: EMORA 쪽 값은 너희가 가장 잘 알지만, 그래도 **공개 출처(tryemora.com, 앱스토어, 공식 문서)** 를 근거로 적는다. 내부 비공개 사실은 `source_url`에 `"internal"` 로 표기하고 `notes`에 근거를 적되, 공개 검증 불가한 건 보수적으로.
8. **claim-ready 문장**: 각 `value`는 **그 자체로 완결된 사실 문장**으로 쓴다. (비교 페이지에 거의 그대로 인용된다.)

---

## 2. 대상 경쟁사 (8개)

| key | 이름 | 공식 URL(확인 후 정확히) |
|---|---|---|
| character_ai | Character.AI | https://character.ai |
| talkie | Talkie (Talkie AI) | (확인) |
| chai | Chai | (확인) |
| replika | Replika | https://replika.com |
| nomi | Nomi (Nomi.ai) | (확인) |
| kindroid | Kindroid | (확인) |
| janitor_ai | Janitor AI | (확인) |
| novel_ai | NovelAI | https://novelai.net |

> 각 경쟁사의 **공식 URL을 먼저 확인**하고 `official_url`에 정확히 기입.

---

## 3. 비교 항목 (dimensions) — 항목별로 EMORA + 8경쟁사 값 수집

### 그룹 A — 핵심 기능 (core_features)
| key | 라벨 | 무엇을 찾나 |
|---|---|---|
| long_term_memory | 장기/영구 기억 | 세션 간 대화·관계를 영구 기억하는가? 한도/방식 |
| image_generation | 대화 중 이미지 생성 | 채팅 내 이미지 생성 기능 유무 |
| group_chat | 그룹 채팅 | 여러 AI 캐릭터와 동시 대화 가능 여부 |
| character_creation | 캐릭터 생성/편집 | 사용자 커스텀 캐릭터 생성·세계관/시나리오 설정 |
| creator_economy | 크리에이터 이코노미 | 캐릭터 제작·공유·수익화 지원 여부 |

### 그룹 B — 요금/접근성 (pricing_access)
| key | 라벨 | 무엇을 찾나 |
|---|---|---|
| free_tier | 무료 이용 범위 | 무료로 무엇이 가능한가 (메시지 한도 등) |
| paid_pricing | 유료 가격 | 구독/요금 (통화·월 가격, 확인일 기준) |
| supported_languages | 지원 언어 수 | 지원 언어 개수/목록 |
| platforms | 플랫폼 | iOS / Android / 웹 지원 여부 |

### 그룹 C — 콘텐츠 정책 (content_policy) — **중립 수집, 비방 금지**
| key | 라벨 | 무엇을 찾나 |
|---|---|---|
| content_policy | SFW/NSFW 정책 | 공식 정책상 성인/NSFW 허용 여부 (정책 문서 인용) |
| age_rating | 연령 등급 | 앱스토어 연령 등급/이용 연령 정책 |

> ⚠️ 콘텐츠 정책은 **출처 있는 중립 사실로만** 수집한다. 발행 페이지에서는 이 항목을 강조하지 않고 "중립적 기능 비교" 기조로 다룬다(사장님 결정). 비방·도덕적 평가 절대 금지.

### 그룹 D — 안전/신뢰 (safety_trust)
| key | 라벨 | 무엇을 찾나 |
|---|---|---|
| data_privacy | 데이터/프라이버시 | 개인정보 처리방침의 핵심(데이터 보관·학습 사용 등) |
| company_info | 운영사 정보 | 운영 회사/출시 시기 등 공개 정보 |
| scale_metrics | 규모 지표 | 공개된 사용자 수·다운로드 수 등(출처 있을 때만) |

### 그룹 E — 추가 (선택, Other)
사장님이 추가로 원한 항목이 있으면 여기에. (없으면 비워둠) — 예: 음성 통화, 멀티모달, API 등. 추가 시 동일 형식(key/라벨/출처)으로.

---

## 4. 출력 형식 (정확히 이 스키마로 `emora-competitor-facts.json` 1개 파일)

```json
{
  "meta": {
    "brand": "EMORA",
    "prepared_by": "<이름 또는 이메일>",
    "date_prepared": "2026-06-26",
    "overall_notes": "가격/기능은 확인일 기준. unknown=공개 출처 미발견."
  },
  "dimensions": [
    { "key": "long_term_memory", "group": "core_features", "label": "장기/영구 기억" }
    // 위 3장의 모든 dimension을 여기에 나열 (key, group, label)
  ],
  "emora": {
    "long_term_memory": {
      "value": "EMORA는 AI 캐릭터가 과거 상호작용과 디테일을 영구 기억하는 무한 메모리를 제공한다.",
      "source_url": "https://tryemora.com/...",
      "source_quote": "출처 원문에서 이 사실을 뒷받침하는 정확한 문장",
      "date_checked": "2026-06-26",
      "confidence": "high",
      "notes": ""
    }
    // EMORA의 모든 dimension 값
  },
  "competitors": [
    {
      "name": "Character.AI",
      "key": "character_ai",
      "official_url": "https://character.ai",
      "facts": {
        "long_term_memory": {
          "value": "Character.AI는 세션 간 영구 장기기억을 기본 제공하지 않는다.",
          "source_url": "https://...(실제 확인한 URL)",
          "source_quote": "출처 원문 인용",
          "date_checked": "2026-06-26",
          "confidence": "high",
          "notes": "무료/유료 무관 기본 동작 기준"
        },
        "image_generation": {
          "value": "unknown",
          "source_url": "",
          "source_quote": "",
          "date_checked": "2026-06-26",
          "confidence": "low",
          "notes": "공식 출처에서 확인 불가"
        }
        // 모든 dimension. 모르면 value:"unknown".
      }
    }
    // 8개 경쟁사 전부 동일 구조
  ]
}
```

### 필드 정의
- `value`: 완결된 사실 문장(한국어 또는 영어 — **영어 권장**, 글로벌 페이지에 쓰임). 모르면 `"unknown"`.
- `source_url`: 그 값을 뒷받침하는 **실제로 연 공개 URL**. EMORA 내부근거면 `"internal"`.
- `source_quote`: 출처에서 발췌한 원문(짧게). 사실을 직접 뒷받침해야 함.
- `date_checked`: 확인 날짜 YYYY-MM-DD.
- `confidence`: `high`(공식 1차 출처) / `medium`(신뢰 2차 보도) / `low`(불확실·간접).
- `notes`: 단서/조건(무료티어 기준, 지역차, 변동성 등).

> **읽기용 미러**: 같은 내용을 `emora-competitor-facts.md`에 dimension × 경쟁사 표로도 만들어 주면 사람이 검수하기 좋다(선택).

---

## 5. 작업 순서 (권장)

1. 8개 경쟁사 **공식 URL 확인** → `official_url` 기입.
2. dimension별로 **EMORA 값 먼저** 채움(공개 출처 근거).
3. 경쟁사별로 dimension을 돌며 **공식 사이트 → 요금/도움말 → 앱스토어 → Wikipedia/프레스** 순으로 출처 탐색.
4. 출처를 찾으면 `value`+`source_url`+`source_quote`+`date_checked`+`confidence` 기입. **못 찾으면 unknown.**
5. 가격·언어수 등 **숫자는 출처 원문 그대로** (반올림/추정 금지).
6. 전체 JSON 스키마 유효성 점검(필드 누락 없음) 후 저장.
7. (선택) MD 표 미러 생성.

---

## 6. 품질 체크리스트 (제출 전 자가검증)

- [ ] 모든 경쟁사 사실에 `source_url` + `source_quote` + `date_checked` 있음 (unknown 제외)
- [ ] 추측/일반상식으로 채운 값 없음 (모르면 전부 unknown)
- [ ] 비방·주관 평가 표현 없음 (중립 사실만)
- [ ] 콘텐츠 정책 항목은 출처 있는 중립 서술만
- [ ] 숫자(가격·언어수·규모)는 출처 원문과 일치
- [ ] JSON 스키마 유효 (모든 dimension × 8경쟁사 + EMORA 채움)
- [ ] `value`가 그 자체로 완결된 사실 문장

---

## 7. 산출물 전달

- 파일명: **`emora-competitor-facts.json`** (필수) + `emora-competitor-facts.md`(선택)
- 전달: 이 파일을 AEO/GEO 담당(이 프로젝트)에게 전달.
- 받으면: 우리가 `claim_source`로 등록 → 비교/대안 페이지 생성 → §7 게이트 통과분만 owned-net 허브에 발행 → 색인.

> 질문/불명확한 항목이 있으면 채우지 말고 `notes`에 "질문: ..."으로 남겨라. 사람이 결정한다.
