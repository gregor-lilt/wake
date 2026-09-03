# scratch-project

Toy repo for Wake spike 4. Nothing here matters, it exists so a live Claude
Code session has something small to edit while the Wake hook server watches.

- `src/greet.ts` - greeting helper
- `src/math.ts` - two arithmetic helpers
- `src/main.ts` - entry point that uses both
- `protected/` - fenced directory. Wake's PreToolUse hook denies edits here,
  and `.claude/settings.local.json.example` adds a matching deny rule.

## Notes

(the agent may be asked to append a line here)
