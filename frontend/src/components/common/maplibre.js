import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre v6 loads its worker as a separate ES module. Give Vite its URL so
// production builds emit the file instead of the browser requesting a missing
// relative asset.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

export { maplibregl };
