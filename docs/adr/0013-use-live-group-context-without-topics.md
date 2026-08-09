# Use live Group Context without Feishu topics

Minori uses the ordinary group chat ID as the shared **Group Context**, replies
without intentionally creating Feishu topics, and serializes invocations within
that group while retaining four-way concurrency across different groups and
private chats. A direct mention or reply to Minori is the **Current Invocation**;
ordinary group messages do not trigger the Agent but a bounded, cutoff-safe window
of them becomes **Live Group History** for an invoked run.

Bot Authority reads that history and current group display names on demand. The
history may be sent to the configured model but is not mirrored into Neon, and
historical instructions are background rather than independent authorization.
This chooses natural group-level understanding over reply-thread isolation while
limiting duplicate retention and avoiding an always-on group listener. It requires
group-history and group-member read permissions and does not claim non-topic
behavior inside Feishu topic-mode groups.
