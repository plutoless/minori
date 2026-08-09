# Trust the configured model data boundary

Minori treats the operator configured at `OPENAI_BASE_URL` as a trusted data processor for the entire Knowledge Boundary. Agent runs may send it visible conversation history, relevant knowledge content, and tool results. Every compatible Responses request uses `store: false`, while Minori explicitly does not claim that this flag independently proves a third-party intermediary's retention or deletion behavior.

Minori does not place content redaction, keyword blocking, or a classification gateway in front of the model because those mechanisms would remove context and reduce the open Agent's effectiveness without creating a reliable trust boundary. If the configured endpoint is not acceptable for the Knowledge Boundary, the remedy is to switch to a trusted official or private model endpoint. Prompt instructions are not a substitute for trusting the processor that receives plaintext input.
