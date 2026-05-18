# Development Plan

## Phase 0
Create Chrome Extension skeleton:
- Manifest V3
- React + TypeScript + Tailwind
- Chrome Side Panel
- YouTube content script
- Read videoId, URL, title, durationSeconds
- Side Panel entry states:
  - identifying current page
  - current video cannot be parsed
  - parse current video CTA
  - parsing progress
  - parsed learning view
- Five tabs only appear after the current video is parsed or partially completed with usable subtitle data

## Phase 1
Mock learning flow:
- Mock parse current video flow
- Overview tab
- Lyric-style subtitles
- Chinese subtitles expanded by default
- Text selection actions
- Mock chat
- Mock notes
- Mock vocabulary
- Empty states for chat, notes, vocabulary
- Generated-content failure state for overview modules
- Auto-add vocabulary from selected subtitles without candidate confirmation

## Phase 2
Parse validation and progress UI

## Phase 3
Supabase schema and auth

## Phase 4
Data persistence

## Phase 5
ModelProvider and real AI

## Phase 6
SearchProvider

## Phase 7
Real YouTube transcript fetching

## Phase 8
Production packaging and Chrome Web Store release
