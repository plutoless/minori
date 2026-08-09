# Use dedicated-user permissions as the knowledge boundary

Minori treats the Feishu permissions of its Dedicated Knowledge User as the sole Knowledge Boundary. We deliberately do not add an application-level allowlist of spaces or document roots and do not re-filter results using the requesting member's own document permissions. This keeps access behavior aligned with one native Feishu identity and reduces configuration drift.

The Dedicated Knowledge User is therefore an intentional knowledge-publication identity. Any content shared with it becomes available through Minori to every Feishu Delivered Member, including an external collaborator whose own Feishu account could not open the source. Operators must grant this account access only to content suitable for every audience that can reach the App. This cross-user disclosure is an accepted product behavior, not an authorization fallback.
