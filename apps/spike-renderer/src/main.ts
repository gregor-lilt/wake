/**
 * Spike 1's shell. The renderer itself moved to packages/map; what is left
 * here is the page it hangs off and the scripted runs in scripts/, which are
 * the map's regression suite and stay pointed at this app.
 *
 * `?data=<name>` plays a real repository export, otherwise the synthetic
 * fixture. Both paths are the package's, unchanged.
 */
import '@wake/map/style.css';
import '@wake/map/splash.css';
import { createMap } from '@wake/map';

const map = createMap(document.getElementById('app')!, {});
await map.loadDocument(null);
