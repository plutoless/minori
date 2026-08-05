# Minori Team Agent Roadmap Prototype

This is a throwaway decision prototype. It summarizes the agreed roadmap and visualizes example Feishu interactions; it is not the production UI.

From the repository root, run:

```bash
python3 -m http.server 4173 --directory prototypes/roadmap
```

Then open `http://localhost:4173/?variant=A`.

- Use the bottom switcher or left/right arrow keys for variants A, B, and C.
- Use the bottom-right control to adjust density and motion for the current session.
- Variant choice is shareable in the URL. Other prototype settings are intentionally not persisted.

Decision question: which information architecture should be absorbed into the eventual project documentation or operator UI—A (executive atlas), B (technical control room), or C (narrative walkthrough)?
