# Sayki

좋아하는 영상으로 하는 영어 쉐도잉 연습 서비스. 유튜브(또는 영상 파일) 링크를 붙여 넣으면 자막을 문장 단위로 나눠 레슨을 만들고, 한 문장씩 듣고 → 따라 말하고 → 단어별 발음 점수를 받습니다.

## 실행

Node **20.19 이상**이 필요합니다(Tailwind v4가 `require(esm)`을 사용). `.nvmrc`는 22(LTS)입니다.

```bash
npm install
npm run dev          # http://localhost:3000
```

선택 설정은 `.env.example`을 `.env.local`로 복사해서 채웁니다.

| 변수 | 용도 |
|---|---|
| `SAYKI_PASSWORD` | 사이트 전체 비밀번호 잠금(개인용). 배포 환경에서는 필수. 없으면 배포본은 모든 요청에 503을 돌려주고, 로컬 `npm run dev`는 잠금 없이 열림. 바꾸면 모든 기기가 로그아웃됨 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (또는 `KV_REST_API_URL` / `KV_REST_API_TOKEN`) | 레슨 저장소(Upstash Redis). 없으면 로컬 파일(`./.data`)에 저장 — 로컬 개발 전용 |
| `YOUTUBE_PROXY_URL` | 유튜브 요청에만 쓰는 회전형 주거용 프록시 (`http://아이디:비밀번호@호스트:포트`). Vercel 같은 데이터센터 IP는 유튜브에 차단되므로 배포 환경에서는 필수. 없으면 직접 요청(로컬 개발) |
| `ANTHROPIC_API_KEY` | Claude로 문장별 한글 번역 생성 (한→영 말하기 모드에 필요). 레슨을 처음 열 때 한 번 번역해 저장 |
| `ANTHROPIC_TRANSLATE_MODEL` | 번역 모델 (기본 `claude-opus-5-5`, 저렴한 대안 `claude-haiku-5-5`) |
| `TRANSLATE_DAILY_LIMIT` | 하루 최대 번역 레슨 수 (기본 100) — 비용 안전장치 |
| `OPENAI_API_KEY` | 유튜브가 아닌 영상/오디오 링크(.mp4, .mp3 …, 25MB 이하)의 자막을 Whisper로 자동 생성. 없으면 자막 파일(.srt/.vtt) 업로드 필요 |
| `SAYKI_DATA_DIR` | 로컬 파일 저장 위치 (기본 `./.data`) |

## Vercel 배포

1. [vercel.com/new](https://vercel.com/new)에서 GitHub 저장소 `kish191919/Sayki`를 Import → 설정 그대로 Deploy
2. 프로젝트 → **Storage** → **Upstash for Redis**(Marketplace, 무료 플랜) 생성 → 이 프로젝트에 Connect
   - `KV_REST_API_URL`, `KV_REST_API_TOKEN` 환경 변수가 자동으로 추가됩니다.
3. **Settings → Environment Variables**에 `SAYKI_PASSWORD`와 `YOUTUBE_PROXY_URL` 추가 (회전형 **주거용** 프록시. 데이터센터·고정 IP 프록시는 유튜브에 막힘)
4. (선택) `OPENAI_API_KEY` 추가
5. **Deployments** → 최신 배포 → **Redeploy** (환경 변수는 재배포해야 적용됨)

이후 `main` 브랜치에 푸시하면 자동으로 배포됩니다. Redis를 연결하지 않으면 레슨 만들기가 "서버 저장소가 아직 연결되지 않았어요" 오류를 냅니다.

## MVP 기능

- **레슨 만들기** (`POST /api/lessons`)
  - 유튜브: 영어 자막을 가져와 문장 단위로 분할. 사람이 만든 자막 우선, 없으면 자동 자막(단어별 타이밍으로 쉼 기준 분할)
  - 한국어 자막 트랙이 있으면 문장별 한글 해석을 시간축으로 연결, 없으면 유튜브 자동 번역 시도(실패 시 생략)
  - 자막이 없는 영상 / 영상 파일 링크: `.srt`·`.vtt` 업로드, 또는 `OPENAI_API_KEY`로 자동 생성
  - 같은 유튜브 영상은 한 번만 가져오고 저장된 레슨을 재사용
- **연습실** (`/lesson/[id]`)
  - 문장 끝 자동 정지, 재생 방식 4가지(문장마다 멈춤 / 자동 넘김 1배·1.5배 / 이어서 재생)
  - 문장 반복, 속도 0.5–1.5배, 자막 싱크 ±0.1초, 영어·한글 자막 숨기기
  - 녹음(무음 감지 자동 종료) → 브라우저 음성 인식(Web Speech API) → 단어별 정오 표시와 점수
  - 내 녹음 듣기, 원본 → 내 녹음 비교 듣기
  - 단축키: Space 듣기/멈춤, ←/→ 이전/다음, R 녹음, L 반복
- **한→영 말하기 모드**: 한글 해석만 보고 영어로 말하기 → 원문 공개·일치율·원어민 음성 비교. 힌트(단어 첫 글자), 정답 보기
  - `ANTHROPIC_API_KEY`가 있으면 레슨을 처음 열 때 Claude가 문장마다 1:1로 번역해 저장 (`POST /api/lessons/[id]/translate`)
  - 없으면 유튜브 한국어 자막이 있는 영상에서만 사용 가능
- **진도 저장**: 문장별 최고 점수(모드별)·마지막 위치·최근 레슨을 브라우저(localStorage)에 저장

## 구조

```
src/
  proxy.ts                   사이트 전체 비밀번호 잠금 (lib/auth.ts, app/login, api/auth/login)
  app/
    page.tsx                 홈 (링크 입력, 이어서 연습하기, 최근 레슨)
    lesson/[id]/page.tsx     레슨 페이지 (서버: 레슨 로드 → 클라이언트 연습실)
    api/lessons/route.ts     레슨 생성 API
  components/
    CreateLessonForm.tsx     링크/자막 파일 입력
    room/ShadowingRoom.tsx   연습실 (재생 엔진, 녹음, 채점 UI)
    room/players.tsx         YouTube IFrame / HTML5 video 플레이어 어댑터
    room/useRecorder.ts      MediaRecorder + 음성 인식 + 무음 감지
  lib/
    youtube.ts               링크 파싱, 자막 트랙 조회·다운로드(json3)
    segment.ts               단어 스트림 → 연습 문장 분할, 한글 해석 정렬
    subtitles.ts             .srt/.vtt 파서
    transcribe.ts            Whisper 자동 자막 (선택)
    safe-fetch.ts            외부 파일 다운로드 (사설망 차단, 크기 제한)
    score.ts                 발음 채점 (축약형·숫자·동음이의어 허용 정렬)
    store.ts                 레슨 저장소 (MVP: JSON 파일)
    progress.ts              브라우저 진도·설정 저장
```

## 알려진 한계

- **자막 수집 방식**: 유튜브 자막은 공식 Data API가 아닌 유튜브 앱 내부 API로 가져옵니다. 유튜브 정책상 회색 지대이고, 예고 없이 막히거나 서버 IP가 차단될 수 있습니다(자동 번역 요청은 이미 자주 429로 막힘). Vercel(AWS) IP는 유튜브 봇 확인에 항상 걸려서(`YOUTUBE_BLOCKED`), 유튜브 요청만 `YOUTUBE_PROXY_URL`의 회전형 주거용 프록시로 보냅니다. 막히면 새 IP로 재시도하지만 프록시 IP도 차단될 수 있습니다. 자막 파일 업로드는 프록시 없이도 동작합니다. 서비스 전에 법률 검토가 필요합니다.
- **저장소**: 레슨만 Redis에 저장합니다(무료 플랜 256MB ≈ 레슨 수천 개). 사용자 계정·학습 기록용 DB는 아직 없습니다.
- **채점**: 브라우저 음성 인식 결과와 원문을 비교하는 방식이라 음소 단위 발음 평가는 아닙니다. Firefox는 음성 인식을 지원하지 않습니다(녹음·비교 듣기는 가능).
- **계정 없음**: 진도는 브라우저에만 저장됩니다.
- **개인용 잠금**: `src/proxy.ts`가 페이지와 API 전체를 `SAYKI_PASSWORD` 하나로 잠급니다(로그인 시도는 IP당 15분에 10회). 로그인한 뒤에는 `/api/lessons`에 별도 요청 제한이 없습니다.

## 다음 단계 후보

1. 로그인(Google·카카오) + DB 저장 (Supabase 등)
2. 발음 평가 API(음소·유창성 점수) 연동
3. 한글 해석이 없는 영상에 LLM 번역, 자동 자막 문장 부호 복원
4. 받아쓰기 모드, 단어장, 문장 분할 직접 수정
5. 레이트 리밋, 에러 모니터링, 배포
