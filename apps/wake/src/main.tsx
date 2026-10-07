/**
 * Entry point. The map's own stylesheet comes first so nothing the package
 * draws flashes unstyled, then the shell's.
 */
import '@wake/map/style.css';
import '@wake/map/splash.css';
import './app.css';
import { render } from 'solid-js/web';
import { App } from './App';

render(() => <App />, document.getElementById('root')!);
