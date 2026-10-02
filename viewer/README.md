# Local sequence viewer

Run `npm start` from the contract repository. Open the collector's ordinary loopback URL. Reader credentials bootstrap automatically and stay separate from producer credentials.

Devices and environments → Apps → Sessions lists enrolled sources, including apps with no events. Browser environments are origin-scoped local IDs, not verified physical devices. Native labels use actual package/bundle identifiers. Last-seen means recent presence is unknown; it does not complete a session.

Session summaries are paged separately from capture events. Selecting a source or logical session fetches only its retained events at a fixed high-water mark. Selection, pause and collector changes fence old responses. Shared logical sessions preserve their identity across sources; source filtering restricts displayed recordings. Very large selected sessions exceed the diagram limit and require capture export/smaller file inspection.

Pause live stops viewer updates; collection continues. Importing a file pauses live viewing. Resume live returns to the collector. Save capture exports collector retention, rather than only the selected session. Static `npm run viewer` remains a local file viewer.

Build with `npm run build:viewer`; verify live bootstrap/reconnect/import/pause/resume through `npm run check:live-setup` with installed Google Chrome.
