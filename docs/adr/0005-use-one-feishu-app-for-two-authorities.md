# Use One Feishu App for Two Authorities

Minori uses one custom Feishu application for both Bot Authority and Delegated Knowledge Authority to avoid a second app lifecycle and duplicate permission review. The authorities remain separate: app credentials authorize messaging and membership calls, while the Dedicated Knowledge User's OAuth grant is the only authority accepted for knowledge operations; Minori never falls back from user identity to bot identity.

## Consequences

The app must publish both bot-facing permissions and the intended user-level Drive, Docs, and Wiki API capabilities. OAuth is requested by those business domains, while concrete content access follows the Dedicated Knowledge User. Minori exposes typed read, create, append, and targeted patch tools; destructive and authority-changing operations remain absent even if the user's grant permits them. Operators rotate the app credential and the user OAuth grant independently. The CLI profile enforces `strict-mode=user`, knowledge commands explicitly pass `--as user`, and Minori verifies the logged-in identity once after OAuth rather than parsing identity metadata from every command response.
