# Use dedicated-user permissions as the knowledge boundary

Minori treats the Feishu permissions of its Dedicated Knowledge User as the sole Knowledge Boundary. We deliberately do not add an application-level allowlist of spaces or document roots: this keeps access behavior aligned with native Feishu sharing and reduces configuration drift, while accepting that any content later shared with the dedicated account becomes accessible to the Agent.
