import React from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';
import {TrackerCommandHeaderStatus} from '../tracker-command-feedback.jsx';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('primary hardware status', () => {
    it('returns to current hardware status after three seconds without extending on telemetry updates', () => {
        vi.useFakeTimers();
        const command = {commandId: 'move', action: 'move', status: 'succeeded', updatedAt: Date.now()};
        const {rerender} = render(<TrackerCommandHeaderStatus command={command} hardwareStatus="Stopped" />);
        expect(screen.getByRole('status')).toHaveTextContent(/^Position reached$/);
        act(() => vi.advanceTimersByTime(2000));
        rerender(<TrackerCommandHeaderStatus command={{...command}} hardwareStatus="Tracking" />);
        act(() => vi.advanceTimersByTime(1000));
        expect(screen.getByRole('status')).toHaveTextContent(/^Tracking$/);
        expect(screen.getByRole('status')).toHaveAttribute('title', expect.stringContaining('Position reached'));
    });

    it('does not replay old success when the dialog reopens', () => {
        vi.useFakeTimers();
        const command = {action: 'move', status: 'succeeded', updatedAt: Date.now()};
        const {unmount} = render(<TrackerCommandHeaderStatus command={command} hardwareStatus="Stopped" />);
        unmount();
        act(() => vi.advanceTimersByTime(4000));
        render(<TrackerCommandHeaderStatus command={command} hardwareStatus="Stopped" />);
        expect(screen.getByRole('status')).toHaveTextContent(/^Stopped$/);
    });

    it('keeps a newer operation visible when the previous success expires', () => {
        vi.useFakeTimers();
        const command = {action: 'move', status: 'succeeded', updatedAt: Date.now()};
        const {rerender} = render(<TrackerCommandHeaderStatus command={command} hardwareStatus="Stopped" />);
        act(() => vi.advanceTimersByTime(1000));
        rerender(<TrackerCommandHeaderStatus command={{action: 'move', status: 'started'}} hardwareStatus="Slewing" />);
        act(() => vi.advanceTimersByTime(4000));
        expect(screen.getByRole('status')).toHaveTextContent(/^Moving…$/);
    });

    it('retains uncertainty until reconciliation and never shows success over stale hardware', () => {
        vi.useFakeTimers();
        const command = {action: 'move', status: 'unknown'};
        const {rerender} = render(<TrackerCommandHeaderStatus command={command} hardwareStatus="Stopped" />);
        act(() => vi.advanceTimersByTime(5000));
        expect(screen.getByRole('status')).toHaveTextContent(/^Status unknown$/);
        rerender(<TrackerCommandHeaderStatus command={{...command, reconciled: true}} hardwareStatus="Stopped" />);
        expect(screen.getByRole('status')).toHaveTextContent(/^Stopped$/);
        rerender(<TrackerCommandHeaderStatus stale hardwareStatus="Stopped"
            command={{action: 'move', status: 'succeeded', updatedAt: Date.now()}} />);
        expect(screen.getByRole('status')).toHaveTextContent(/^Hardware status unavailable$/);
    });
});
