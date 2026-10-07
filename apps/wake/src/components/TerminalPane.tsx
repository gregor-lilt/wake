/**
 * The place the embedded terminal will go: a split pane on the left, collapsed
 * by default, that the control cluster opens. Empty on purpose. Wake's runtime
 * is Bun, whose built-in PTY is what will fill this (docs/research-stack.md
 * section 2), and nothing about the map should have to move when it does.
 */
export interface TerminalPaneProps {
  open: boolean;
  onClose(): void;
}

export function TerminalPane(props: TerminalPaneProps) {
  return (
    <aside class="term" id="term" aria-label="terminal">
      <div class="term-head">
        <span class="term-title">terminal</span>
        <button class="term-close" id="term-close" title="close" onClick={() => props.onClose()}>
          ×
        </button>
      </div>
      <div class="term-body" id="term-body">
        <p>
          Nothing runs here yet. The session on the map is Claude Code driving
          the repository from wherever it was started; this pane is where it
          will be driven from instead.
        </p>
      </div>
    </aside>
  );
}
