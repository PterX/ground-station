import {act, renderHook} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    getMapErrorMessage,
    sanitizeMapErrorMessage,
    useMapLoadFailure,
} from '../map-load-error.jsx';

describe('map load failure handling', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports a renderer that never finishes loading and clears on retry', () => {
        vi.useFakeTimers();
        const {result} = renderHook(() => useMapLoadFailure({
            engine: 'MapLibre',
            loadKey: 'maplibre:satellite',
            timeoutMs: 1000,
        }));

        act(() => vi.advanceTimersByTime(1000));
        expect(result.current.failure).toEqual({
            engine: 'MapLibre',
            message: 'MapLibre did not finish loading the selected basemap within 1 second.',
        });

        act(() => result.current.retry());
        expect(result.current.failure).toBeNull();
        expect(result.current.attempt).toBe(1);
    });

    it('does not report a timeout after the basemap has loaded', () => {
        vi.useFakeTimers();
        const {result} = renderHook(() => useMapLoadFailure({
            engine: 'Leaflet',
            loadKey: 'leaflet:osm',
            timeoutMs: 1000,
        }));

        act(() => result.current.reportLoaded());
        act(() => vi.advanceTimersByTime(1000));
        expect(result.current.failure).toBeNull();
    });

    it('redacts tile-provider credentials from technical errors', () => {
        expect(sanitizeMapErrorMessage(
            'Request failed: https://tiles.example/1/2/3.png?api_key=secret-value&style=dark'
        )).toBe(
            'Request failed: https://tiles.example/1/2/3.png?api_key=[redacted]&style=dark'
        );
        expect(getMapErrorMessage(
            {error: {message: 'Worker failed with access_token=another-secret'}},
            'Fallback'
        )).toBe('Worker failed with access_token=[redacted]');
    });
});
