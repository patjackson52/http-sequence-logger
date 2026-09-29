# No consumer keep rules are needed: the API uses direct calls, with no reflection/JNI/serialization.
# The implementation is debug-only and must already be absent from the release dependency graph.
# Prevent inlining/merging from concealing accidental inclusion before asserting discard.
-keep,allowshrinking class dev.networklog.logger.** { *; }
-checkdiscard class dev.networklog.logger.**

# Do NOT use -assumenosideeffects on Session.invokeHandler or the HTTP client:
# both execute real customer code even when recording is disabled.
