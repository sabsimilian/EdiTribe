# Editribe is a desktop sample-bank manager for the Korg Electribe 2S.

It is built to make large sample workflows practical: import audio from many formats, organize samples by category, manage slot numbering, trim/preview audio, and export Electribe-compatible `.all` banks.

## What The App Does

- Import audio from folders or drag and drop directly into the app.
- Support common formats (`.wav`, `.mp3`, `.flac`, `.ogg`, `.aiff`, `.aif`, `.m4a`, `.opus`).
- Load existing Electribe `.all` banks for inspection and rework.
- Organize sample sets in separate Import and Export lists.
- Group and sort by category with drag-and-drop category order.
- Manage slot numbering for large banks:
  - Continuous numbering by default.
  - Manual slot edits to create intentional gaps.
  - Reflow behavior that updates following rows while keeping earlier rows stable.
- Edit samples with waveform tools:
  - Trim start/end.
  - Zoom and playback preview.
  - BPM/grid snap for timing-aware edits.
- Export Electribe-compatible `.all` files with strict validation.
- Show RAM usage estimate against Electribe memory limits.

## Typical Workflow

1. Import samples (folder or drag and drop).
2. Review and set categories.
3. Move selected items into the Export list.
4. Use Group and sort to structure category order.
5. Adjust slot starts where needed (for example reserve future space for specific categories).
6. Optionally trim/edit individual samples.
7. Export `.all` and import to Electribe 2S.

## Export Reliability Notes

- The exporter validates slot assignments and encoded sample data before writing.
- Export summary includes written count and slot range.
- Export aborts on invalid/duplicate slot state instead of silently producing partial output.

### Install

Just download the electribe.exe from this page, hit install and you´re good to go - as simple as that

