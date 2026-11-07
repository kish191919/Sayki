# Sayki

좋아하는 영상으로 하는 영어 쉐도잉 연습 서비스. 유튜브(또는 영상 파일) 링크를 붙여 넣거나 기기에 저장한 영상(인스타그램 릴스·틱톡 등)을 올리면 자막을 문장 단위로 나눠 레슨을 만들고, 한 문장씩 듣고 → 따라 말하고 → 단어별 발음 점수를 받습니다.

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
| `OPENAI_API_KEY` | 유튜브가 아닌 영상/오디오 링크(.mp4, .mp3 …, 25MB 이하)의 자막을 Whisper로 자동 생성. 없으면 자막 파일(.srt/.vtt) 업로드 필요. 강의 스크립트의 영어 음성(TTS)에도 필요 |
| `BLOB_STORE_ID` (또는 `BLOB_READ_WRITE_TOKEN`) | 강의 스크립트 음성(MP3)과 올린 영상 파일의 저장소(Vercel Blob, **Private** 스토어). 배포 환경에서 강의 스크립트·영상 올리기를 쓰려면 필수. 스토어를 프로젝트에 연결하면 `BLOB_STORE_ID`가 추가되고 Vercel 함수의 OIDC 토큰으로 인증(읽기·쓰기 토큰 불필요). 없으면 로컬 파일(`./.data/audio`, `./.data/media`)에 저장 — 로컬 개발 전용 |
| `ANTHROPIC_SCRIPT_MODEL` | 강의 스크립트를 쓰는 모델 (기본 `claude-opus-5-5`) |
| `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | 강의 스크립트 영어 음성 모델·목소리 (기본 `gpt-4o-mini-tts` / `marin`. 다른 목소리 예: `cedar`, `coral`) |
| `SCRIPT_DAILY_LIMIT` | 하루 최대 스크립트 쓰기 횟수와 음성 만들기 횟수(각각, 기본 30) — 비용 안전장치 |
| `SAYKI_DATA_DIR` | 로컬 파일 저장 위치 (기본 `./.data`) |

## Vercel 배포

1. [vercel.com/new](https://vercel.com/new)에서 GitHub 저장소 `kish191919/Sayki`를 Import → 설정 그대로 Deploy
2. 프로젝트 → **Storage** → **Upstash for Redis**(Marketplace, 무료 플랜) 생성 → 이 프로젝트에 Connect
   - `KV_REST_API_URL`, `KV_REST_API_TOKEN` 환경 변수가 자동으로 추가됩니다.
3. **Settings → Environment Variables**에 `SAYKI_PASSWORD`와 `YOUTUBE_PROXY_URL` 추가 (회전형 **주거용** 프록시. 데이터센터·고정 IP 프록시는 유튜브에 막힘)
4. (선택) `OPENAI_API_KEY` 추가
5. (강의 스크립트·영상 올리기) 프로젝트 → **Storage** → **Blob** → 스토어 생성 시 접근 방식 **Private** 선택 → 이 프로젝트에 Connect (`BLOB_STORE_ID` 자동 추가, "read-write token" 체크는 필요 없음). 강의 스크립트는 `ANTHROPIC_API_KEY`·`OPENAI_API_KEY`, 올린 영상의 자동 자막은 `OPENAI_API_KEY`도 필요
6. **Deployments** → 최신 배포 → **Redeploy** (환경 변수는 재배포해야 적용됨)

이후 `main` 브랜치에 푸시하면 자동으로 배포됩니다. Redis를 연결하지 않으면 레슨 만들기가 "서버 저장소가 아직 연결되지 않았어요" 오류를 냅니다.

## MVP 기능

- **레슨 만들기** (`POST /api/lessons`)
  - 유튜브: 영어 자막을 가져와 문장 단위로 분할. 사람이 만든 자막 우선, 없으면 자동 자막(단어별 타이밍으로 쉼 기준 분할)
  - 한국어 자막 트랙이 있으면 문장별 한글 해석을 시간축으로 연결, 없으면 유튜브 자동 번역 시도(실패 시 생략)
  - 자막이 없는 영상 / 영상 파일 링크: `.srt`·`.vtt` 업로드, 또는 `OPENAI_API_KEY`로 자동 생성
  - 인스타그램·틱톡·페이스북·스레드·X 링크는 가져올 수 없어(재생 제어·자막·안정적인 파일 주소가 없음) "영상 파일 올리기"로 안내
- **영상 파일 올리기** (홈의 "영상 파일 올리기", 폼에 끌어다 놓기도 됨): 기기에 저장한 영상·오디오(MP4·MOV·WebM·MP3·M4A…, 200MB 이하)로 레슨 만들기
  - 브라우저에서: 재생 가능한지 확인 → 카드용 16:9 장면 캡처 → 소리만 뽑아 16kHz 모노 32kbps MP3로 줄이기(Web Audio + lamejs) → 파일은 Vercel Blob에 직접 업로드(`POST /api/uploads`가 presigned URL(`BLOB_STORE_ID`+OIDC) 또는 클라이언트 토큰(`BLOB_READ_WRITE_TOKEN`) 발급; Vercel 함수는 요청당 4.5MB 제한). 업로드와 소리 뽑기는 동시에 진행, 취소 가능, 실패 후 "다시 시도"는 이미 올린 파일을 재사용
  - 서버(`POST /api/lessons/file`): 뽑은 MP3를 Whisper로 받아쓰기(자동 자막은 15분 이하) 또는 함께 고른 `.srt`·`.vtt` 사용 → 문장 분할 → 한글 해석은 다른 레슨처럼 Claude가 처음 열 때 번역. 브라우저가 소리를 못 뽑으면 25MB 이하 파일은 서버가 원본을 Whisper에 보냄
  - 제목: 파일 이름이 사람이 지은 것 같으면 그대로, `IMG_1234`·무작위 ID 같은 이름이면 영상의 첫 문장
  - 재생: `/api/lessons/[id]/media`가 Blob의 짧은 기한 presigned URL로 넘겨 CDN이 구간 요청(탐색)을 직접 처리(presign이 안 되면 함수가 스트리밍). 로컬은 파일을 구간 요청으로 제공. 오디오 파일은 오디오 바로 재생
  - 레슨을 삭제하면 올린 영상·썸네일도 삭제. 로컬 개발에서는 업로드가 `proxy.ts`를 거치므로 `next.config.ts`의 `experimental.proxyClientMaxBodySize`를 210MB로 올려 둠
  - 같은 유튜브 영상은 한 번만 가져오고 저장된 레슨을 재사용
- **연습실** (`/lesson/[id]`)
  - 문장 끝 자동 정지, 재생 방식 4가지(문장마다 멈춤 / 자동 넘김 1배·1.5배 / 이어서 재생)
  - 문장 반복(1·2·3·5번 / 계속). 정한 횟수를 다 들으면 다음 문장으로 넘어가 같은 방식으로 반복, 마지막 문장에서 멈춤. 한→영 모드에서 영어(정답)로 시작하는 반복은 다음 문장으로 옮겨 가서 기다림
  - 속도 0.5–1.5배, 자막 싱크 ±0.1초, 영어·한글 자막 숨기기
  - 녹음(무음 감지 자동 종료) → 브라우저 음성 인식(Web Speech API) → 단어별 정오 표시와 점수
  - 내 녹음 듣기, 원본 → 내 녹음 비교 듣기
  - 단축키: Space 듣기/멈춤, ←/→ 이전/다음, R 녹음, L 반복, B 북마크, Del 문장 삭제 (한→영 모드: H 힌트, K 한국어 듣기)
- **한→영 말하기 모드**: 한글 해석만 보고 영어로 말하기 → 원문 공개·일치율·원어민 음성 비교. 힌트(단어 첫 글자), 정답 보기
  - **한국어 듣고 영어로 말하기**: 한글 해석을 브라우저 한국어 음성(Web Speech API `speechSynthesis`)으로 읽어 주고, 글은 가려 둔 채 듣고 영어로 말하기. 문장을 넘기면 자동으로 읽고, 🔊 버튼·`K`로 다시 듣기, "글로 보기"로 해석 열기. 기기에 한국어 음성이 없으면 글로 보여 줌. 점수는 보고 말하기와 함께 집계
  - `ANTHROPIC_API_KEY`가 있으면 레슨을 처음 열 때 Claude가 문장마다 1:1로 번역해 저장 (`POST /api/lessons/[id]/translate`)
  - 없으면 유튜브 한국어 자막이 있는 영상에서만 사용 가능
- **진도 저장**: 문장별 최고 점수(모드별)·마지막 위치·최근 레슨을 브라우저(localStorage)에 저장
- **내 레슨** (`/lessons`, 헤더 메뉴·홈의 "전체 보기·정리"): 만든 레슨 전체를 정리하는 곳
  - 폴더: 만들기·이름 바꾸기·삭제(안의 레슨은 미분류로). 레슨은 폴더 하나에 들어가고, 없으면 "미분류"
  - 제목 검색(여러 단어 AND), 상태 필터(시작 전 / 연습 중 / 완주 — 이 기기의 진도 기준), 정렬(최근 만든 순 / 최근 연습한 순 / 제목 순), 카드·목록 보기. 정렬·보기 방식은 브라우저에 기억
  - **정리하기**: 레슨을 여러 개 골라 폴더로 옮기기·새 폴더 만들어 담기·삭제. 빈 폴더에서는 "레슨 담기"로 바로 채우기
  - 폴더 정보는 레슨 저장소(Redis의 `library` 키, 로컬은 `.data/library.json`)에 저장되어 기기 간에 같음 (`POST /api/library`)
  - 레슨 삭제는 되돌릴 수 없음(문장·번역과 이 기기의 진도도 삭제). 같은 링크로 다시 만들 수 있음
- **북마크** (`/bookmarks`, 헤더 메뉴): 나중에 다시 연습할 문장 모아 두기
  - 연습실에서 현재 문장의 "북마크" 버튼, `B` 키, 또는 문장 목록 각 줄의 북마크 아이콘으로 저장·해제
  - 문장 목록의 "전체 / 북마크" 탭으로 북마크한 문장만 보기. 이때 이전/다음·자동 넘김·반복 재생도 북마크한 문장만 오감("이어서 재생"은 북마크 문장을 쉬지 않고 연달아 재생)
  - 북마크 페이지: 영상별로 묶어 문장·해석 목록, 검색, 해제(되돌리기 가능). "연습하기"는 `/lesson/[id]?only=bookmarks`(북마크만 모드), 문장을 누르면 그 문장부터(`&s=문장번호`). 영상의 마지막 북마크까지 가면 "다음 영상 북마크 →"로 이어서 연습
  - 레슨 저장소(Redis의 `bookmarks` 해시, 로컬은 `.data/bookmarks.json`)에 저장되어 기기 간에 같음 (`POST /api/bookmarks`). 레슨을 삭제하면 그 레슨의 북마크도 삭제
- **문장 삭제**: 인트로·광고처럼 필요 없는 구간을 지워 다음부터 보지 않기
  - 연습실에서 현재 문장의 "삭제" 버튼이나 `Del`/`Backspace` 키(잠시 "되돌리기" 표시), 또는 문장 목록의 "편집"에서 문장을 눌러 삭제·되돌리기
  - 삭제한 문장은 목록·이전/다음·자동 넘김·반복·이어서 재생에서 모두 건너뜀(영상 자체 컨트롤로 재생해도 다음 문장으로 넘어감). 진도 집계와 북마크 페이지에서도 빠지고, 북마크는 되돌리면 다시 보임
  - 레슨과 따로 저장(Redis의 `lesson-hidden:{id}` 셋, 로컬은 `.data/hidden/{id}.json`)되어 기기 간에 같음 (`POST /api/lessons/[id]/hidden`). 레슨을 삭제하면 함께 삭제
- **강의 스크립트** (`/script`, 헤더 "스크립트"·홈 카드): 교재 사진이나 메모로 초등 4–6학년에게 영어로 설명하는 2–3분 스크립트를 만들어 연습
  - 입력: 사진 최대 5장(사진 찍기·고르기, 브라우저에서 긴 변 1800px JPEG로 줄여 올림) + 직접 적은 내용 + 요청 사항(선택)
  - Claude가 사진을 직접 읽고 스크립트를 씀 (`POST /api/scripts/draft`). 인사·출석·"책 펴세요" 같은 수업 진행 멘트와 페이지 배치 언급은 빼고, "Let's try one together." 같은 설명용 교사 표현은 살림. 한 줄에 한 문장(대략 5–18단어), 수식은 말하는 그대로("three fourths"), 문장마다 해요체 한글(교재의 한국어 용어 사용). 읽기 어려운 부분·추측한 부분은 "확인해 주세요"로 알려 줌
  - 검토·수정: 제목, 문장별 영어·한글 고치기, 삭제, 아래에 추가, 다시 쓰기. 쓰던 초안은 이 브라우저에 저장되어 새로고침해도 남음(사진은 남지 않음)
  - "음성 만들고 연습하기" (`POST /api/scripts`): 문장마다 OpenAI TTS로 영어 음성을 만들어(PCM) 앞뒤 무음을 다듬고 0.45초 쉼을 넣어 하나의 MP3(64kbps 고정 비트레이트)로 인코딩. 문장 시간은 이어 붙인 샘플에서 계산해 정확함. 한글을 비워 둔 문장은 연습실을 열 때 기존 AI 번역으로 채움
  - 연습실은 영상 대신 오디오 바와 "음성 파일 받기 (MP3)" 버튼. 나머지(듣고 따라 말하기, 한국어 듣고 영어로 말하기, 반복, 속도, 채점, 북마크, 문장 삭제)는 다른 레슨과 같음
  - 음성은 Vercel Blob(Private)에 저장하고 `GET /api/lessons/[id]/audio`(사이트 잠금 안, Range 지원, `?download`는 파일 받기)로만 제공. 레슨을 삭제하면 음성도 삭제

## 구조

```
src/
  proxy.ts                   사이트 전체 비밀번호 잠금 (lib/auth.ts, app/login, api/auth/login)
  app/
    page.tsx                 홈 (링크 입력, 이어서 연습하기, 최근 레슨)
    lesson/[id]/page.tsx     레슨 페이지 (서버: 레슨 로드 → 클라이언트 연습실)
    api/lessons/route.ts     레슨 생성 API
    lessons/page.tsx         내 레슨 (폴더·검색·정렬·정리하기)
    api/library/route.ts     폴더 만들기/이름 변경/삭제, 레슨 이동·삭제 API
    bookmarks/page.tsx       북마크한 문장 모아 보기
    api/bookmarks/route.ts   문장 북마크 저장·해제 API
    api/lessons/[id]/hidden/route.ts  문장 삭제·되돌리기 API
    script/page.tsx          강의 스크립트 만들기
    api/scripts/draft/route.ts  자료 → 스크립트 초안 (Claude)
    api/scripts/route.ts     확정한 스크립트 → 영어 음성 → 레슨
    api/lessons/[id]/audio/route.ts  강의 스크립트 MP3 (재생·받기)
  components/
    CreateLessonForm.tsx     링크/자막 파일 입력
    library/LessonLibrary.tsx  내 레슨 화면 (폴더 탭, 필터, 선택 모드)
    bookmarks/BookmarkList.tsx 북마크 화면 (영상별 목록, 검색, 해제·되돌리기)
    room/ShadowingRoom.tsx   연습실 (재생 엔진, 녹음, 채점 UI)
    room/players.tsx         YouTube IFrame / HTML5 video·audio 플레이어 어댑터
    script/ScriptMaker.tsx   강의 스크립트 화면 (자료 입력 → 검토·수정 → 음성 만들기)
    room/useRecorder.ts      MediaRecorder + 음성 인식 + 무음 감지
  lib/
    youtube.ts               링크 파싱, 자막 트랙 조회·다운로드(json3)
    segment.ts               단어 스트림 → 연습 문장 분할, 한글 해석 정렬
    subtitles.ts             .srt/.vtt 파서
    transcribe.ts            Whisper 자동 자막 (선택)
    safe-fetch.ts            외부 파일 다운로드 (사설망 차단, 크기 제한)
    score.ts                 발음 채점 (축약형·숫자·동음이의어 허용 정렬)
    store.ts                 레슨·폴더 저장소 (Redis, 로컬은 JSON 파일)
    library.ts               폴더 정리 작업 검증·적용
    bookmarks.ts             북마크 검증·저장, 북마크 페이지용 묶음 (서버)
    bookmarks-client.ts      북마크 저장 순서 보장·이 탭의 변경 반영 (브라우저)
    hidden.ts                삭제한 문장 검증·저장 (서버) / hidden-client.ts: 브라우저 쪽
    sentence-flags-client.ts 문장별 켜고 끄는 값(북마크·삭제)의 브라우저 저장소 공통 부분
    progress.ts              브라우저 진도·설정 저장
    claude.ts                Claude 클라이언트·fallback 설정 공통 부분 (번역, 강의 스크립트)
    script.ts                강의 스크립트 쓰기 (프롬프트, 응답 검증)
    tts.ts                   OpenAI 영어 음성 (PCM)
    script-audio.ts          문장 음성 잇기·MP3 인코딩·저장 (Vercel Blob / 로컬 파일)
    create-script-lesson.ts  확정한 스크립트 검증 → 강의 스크립트 레슨 저장
```

## 알려진 한계

- **자막 수집 방식**: 유튜브 자막은 공식 Data API가 아닌 유튜브 앱 내부 API로 가져옵니다. 유튜브 정책상 회색 지대이고, 예고 없이 막히거나 서버 IP가 차단될 수 있습니다(자동 번역 요청은 이미 자주 429로 막힘). Vercel(AWS) IP는 유튜브 봇 확인에 항상 걸려서(`YOUTUBE_BLOCKED`), 유튜브 요청만 `YOUTUBE_PROXY_URL`의 회전형 주거용 프록시로 보냅니다. 막히면 새 IP로 재시도하지만 프록시 IP도 차단될 수 있습니다. 자막 파일 업로드는 프록시 없이도 동작합니다. 서비스 전에 법률 검토가 필요합니다.
- **저장소**: 레슨만 Redis에 저장합니다(무료 플랜 256MB ≈ 레슨 수천 개). 강의 스크립트 음성은 Vercel Blob에 저장합니다(3분 ≈ 1.4MB). 사용자 계정·학습 기록용 DB는 아직 없습니다.
- **강의 스크립트**: AI가 쓴 내용이라 수업에 쓰기 전에 검토가 필요합니다. 채점은 원문 일치율이라 스크립트를 자기 말로 바꿔 말하면 점수가 낮게 나옵니다. 스크립트 쓰기는 사진·분량에 따라 1분 안팎, 음성 만들기는 30초 안팎 걸립니다.
- **채점**: 브라우저 음성 인식 결과와 원문을 비교하는 방식이라 음소 단위 발음 평가는 아닙니다. Firefox는 음성 인식을 지원하지 않습니다(녹음·비교 듣기는 가능).
- **계정 없음**: 진도는 브라우저에만 저장됩니다.
- **개인용 잠금**: `src/proxy.ts`가 페이지와 API 전체를 `SAYKI_PASSWORD` 하나로 잠급니다(로그인 시도는 IP당 15분에 10회). 로그인한 뒤에는 `/api/lessons`에 별도 요청 제한이 없습니다.

## 다음 단계 후보

1. 로그인(Google·카카오) + DB 저장 (Supabase 등)
2. 발음 평가 API(음소·유창성 점수) 연동
3. 한글 해석이 없는 영상에 LLM 번역, 자동 자막 문장 부호 복원
4. 받아쓰기 모드, 단어장, 문장 분할 직접 수정
5. 레이트 리밋, 에러 모니터링, 배포
