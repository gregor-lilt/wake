/**
 * The thin control cluster, top right. Three things only: the theme, whether
 * the replay drives the camera, and whether the camera follows what the agent
 * is doing right now. Everything else the user needs is on the map itself
 * (docs/design.md section 10).
 */
import { Show } from 'solid-js';

export interface ControlProps {
  theme: 'dark' | 'light';
  autopilot: boolean;
  connection: string;
  repoName: string | null;
  onTheme(next: 'dark' | 'light'): void;
  onAutopilot(next: boolean): void;
  onFollow(): void;
  terminalOpen: boolean;
  onTerminal(next: boolean): void;
}

export function ControlCluster(props: ControlProps) {
  return (
    <div class="cluster" id="cluster">
      <Show when={props.repoName}>
        <span class="cluster-repo" id="cluster-repo">{props.repoName}</span>
      </Show>
      <button
        id="ctl-theme"
        class="cbtn"
        title="light and dark share every rule; the tone steps invert"
        onClick={() => props.onTheme(props.theme === 'dark' ? 'light' : 'dark')}
      >
        {props.theme === 'dark' ? 'dark' : 'light'}
      </button>
      <button
        id="ctl-autopilot"
        class="cbtn"
        classList={{ on: props.autopilot }}
        title="let the session drive the camera"
        aria-pressed={props.autopilot}
        onClick={() => props.onAutopilot(!props.autopilot)}
      >
        autopilot
      </button>
      <button
        id="ctl-follow"
        class="cbtn"
        title="recentre on what the agent is doing now"
        onClick={() => props.onFollow()}
      >
        follow
      </button>
      <button
        id="ctl-terminal"
        class="cbtn"
        classList={{ on: props.terminalOpen }}
        title="the embedded terminal, once there is one"
        aria-pressed={props.terminalOpen}
        onClick={() => props.onTerminal(!props.terminalOpen)}
      >
        terminal
      </button>
    </div>
  );
}
