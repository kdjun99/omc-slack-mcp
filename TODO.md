# OMC Slack Bidirectional Interface - TODO

## Slack App Dashboard Setup

- [x] Socket Mode 활성화
- [x] App-Level Token 생성 (`xapp-...`, scope: `connections:write`)
- [x] Bot Token Scopes 설정
  - [x] `chat:write` — 메시지 전송
  - [x] `channels:history` — 채널 메시지 읽기
  - [x] `reactions:write` — 이모지 반응 추가
  - [x] `channels:manage` — 채널 자동 생성
  - [x] `incoming-webhook` — 기존 알림 (레거시)
- [x] Event Subscriptions 활성화
  - [x] `message.channels` — 채널 내 스레드 reply 감지
- [x] 앱 재설치 (Reinstall to Workspace)
- [x] 토큰 검증 테스트
  - [x] `auth.test` — Bot User ID: `U0AHJ1FMX3M`
  - [x] `conversations.create` — 채널 자동 생성 확인
  - [x] `chat.postMessage` — 메시지 전송 + `ts` 반환 확인
- [ ] Bot User ID 확인 (본인 Slack User ID, 프로필 > More > Copy member ID)

## Architecture Review

- [x] ARCHITECTURE.md 초안 작성
- [x] Architect 검토 — 5개 gap 발견
- [x] Gap 1 해소: `"slack-bot"` 타입 시스템 통합 (섹션 2 추가)
- [x] Gap 2 해소: `getReplyConfig()` Slack 인식 (섹션 3 보완)
- [x] Gap 3 해소: `findActiveSession()` 정의 (섹션 7 추가)
- [x] Gap 4 해소: 별도 데몬 → 통합 데몬 결정 (섹션 6, 8 재작성)
- [x] Gap 5 해소: 테스트 전략 강화 (Unit/Integration/E2E 3단계)
- [x] 보안 모델 강화 (subtype 필터링, self-ID 확인, 채널 스코프)
- [x] Risk Assessment 보완 (event loss, zombie WS, high event volume)
- [x] 채널 라우팅 기능 추가 (channelRouting, resolveChannel)
- [x] 채널 자동 생성 기능 추가 (autoCreateChannels, resolveOrCreateChannel)
- [x] Phase별 dependency 정리 (@slack/web-api → @slack/bolt)
- [x] .gitignore 생성

---

## Phase 1: Outbound via Bot API

> **Goal:** Bot API로 알림 전송, `ts` 캡처로 스레드 추적 가능하게

### Files to modify (OMC codebase)
- [ ] `src/notifications/types.ts` — `"slack-bot"` to `NotificationPlatform` union
- [ ] `src/notifications/config.ts`
  - [ ] `SlackBotNotificationConfig` interface 추가
  - [ ] `ChannelRoute` interface 추가
  - [ ] Token format validation (`xoxb-*`, `xapp-*`)
  - [ ] `getReplyConfig()` 확장 (slack-bot 인식)
  - [ ] 환경변수 파싱 (OMC_SLACK_BOT_TOKEN, OMC_SLACK_CHANNEL_ROUTING 등)
- [ ] `src/notifications/dispatcher.ts`
  - [ ] `sendSlackBot()` 함수 구현
  - [ ] `resolveOrCreateChannel()` 구현
  - [ ] `deriveChannelName()` 구현
  - [ ] `findChannelByName()` 구현
  - [ ] `dispatchNotifications()`에 `slack-bot` 분기 추가
- [ ] `src/notifications/index.ts` — 메시지 ID 등록 조건에 `"slack-bot"` 추가

### New dependency
- [ ] `@slack/web-api` 설치

### Tests
- [ ] `sendSlackBot()` unit test — payload 형식, ts 추출
- [ ] `SlackBotConfig` validation test — config 파싱, 토큰 검증
- [ ] Channel routing test — pathPattern 매칭, fallback, auto-create
- [ ] Session registry with slack-bot — composite key 등록/조회

### Verification
- [ ] 실제 Slack 채널에 알림 전송 확인
- [ ] `ts` 값이 세션 레지스트리에 등록되는지 확인
- [ ] 채널 라우팅 동작 확인

---

## Phase 2: Inbound via Socket Mode (Thread Replies)

> **Goal:** 스레드 reply를 받아 Claude Code 세션에 주입

### Files to modify
- [ ] `src/notifications/reply-listener.ts`
  - [ ] `initSlackListener()` 함수 추가 (Bolt App 통합)
  - [ ] Thread reply 핸들러 구현
  - [ ] `message.subtype` 필터링
  - [ ] Bot self-ID 확인 (`auth.test`)
  - [ ] `shutdown()` 함수에 Bolt 정리 추가
- [ ] `src/notifications/session-registry.ts` — `"slack-bot"` platform 지원
- [ ] `src/notifications/config.ts`
  - [ ] `authorizedSlackUserIds` to `ReplyConfig`
  - [ ] `getReplyConfig()` slack-bot 인식

### New dependency
- [ ] `@slack/bolt` (replaces `@slack/web-api`)

### Tests
- [ ] Thread reply handler integration test
- [ ] `getReplyConfig()` with Slack-only config test
- [ ] Concurrent registry access test
- [ ] Full injection pipeline E2E test
- [ ] Bolt initialization failure fallback test

### Verification
- [ ] Slack 스레드에서 reply → Claude Code 세션에 텍스트 주입 확인
- [ ] 체크마크 반응 추가 확인
- [ ] Discord/Telegram 폴링이 영향받지 않는지 확인

---

## Phase 3: DM & Mention Interface (Future)

> **Goal:** DM 또는 @mention으로 독립적 명령 전송

### Prerequisites
- [ ] `findActiveSession()` 구현
- [ ] `SessionMapping`에 `userId` 필드 추가
- [ ] `registerMessage()`에 userId 포함

### Slack Dashboard 추가 설정
- [ ] `im:history` scope 추가
- [ ] `im:read` scope 추가
- [ ] `app_mentions:read` scope 추가
- [ ] `message.im` event 추가
- [ ] `app_mention` event 추가
- [ ] 앱 재설치

### Implementation
- [ ] DM 핸들러 구현
- [ ] @mention 핸들러 구현
- [ ] `findActiveSession()` 구현 + 테스트

---

## Phase 4: Response Capture & Streaming (Future)

> **Goal:** Claude 응답을 Slack 스레드에 포스팅

- [ ] tmux pane output 모니터링 설계
- [ ] 응답 파싱 + 포맷팅
- [ ] Slack 스레드에 응답 포스팅
