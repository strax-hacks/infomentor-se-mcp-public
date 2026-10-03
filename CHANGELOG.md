# Changelog

## 1.0.0

- First standalone release of the Swedish InfoMentor MCP server.
- Eight everyday tools are available by default; lower-level detail tools and
  account setup tools are independently opt-in.
- `infomentor_collect_updates` is the preferred high-level workflow and resolves
  supported `NewsItem` and `CalendarV2` notifications automatically.
- Fritidsschema time and parent-comment writes are narrow, explicit, and verified
  by exact read-back.
- Source checkout support uses Bun; the npm distribution targets Node.js 20+.
- The MCP contains InfoMentor access only. Google Calendar synchronization and
  other downstream side effects are intentionally outside this package.
