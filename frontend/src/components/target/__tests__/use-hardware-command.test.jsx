import {afterEach, describe, expect, it, vi} from 'vitest';
import {act, renderHook} from '@testing-library/react';
import {useHardwareCommand} from '../use-hardware-command.js';

afterEach(() => vi.useRealTimers());

describe('hardware command feedback', () => {
    it('expires stationary observations and follows socket disconnect/reconnect', () => {
        vi.useFakeTimers();
        const handlers = {};
        const socket = {connected: true, on: vi.fn((event, handler) => { handlers[event] = handler; }), off: vi.fn()};
        const props = {socket, trackerId: 'target-1', scope: 'rotator', commands: {},
            view: {hardwareObservedAt: Date.now(), hardwareReceivedAt: Date.now()}};
        const {result, rerender, unmount} = renderHook(useHardwareCommand, {initialProps: props});
        expect(result.current.ready).toBe(true);
        act(() => vi.advanceTimersByTime(15000));
        expect(result.current.ready).toBe(false);
        expect(result.current.lastUpdateAge).toBe(15);
        rerender({...props, view: {...props.view, hardwareReceivedAt: Date.now()}});
        expect(result.current.ready).toBe(true);
        act(() => { socket.connected = false; handlers.disconnect(); });
        expect(result.current.ready).toBe(false);
        act(() => { socket.connected = true; handlers.connect(); });
        expect(result.current.ready).toBe(true);
        unmount();
        expect(socket.off).toHaveBeenCalledWith('connect', handlers.connect);
        expect(socket.off).toHaveBeenCalledWith('disconnect', handlers.disconnect);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps unknown commands locked without spinning, then releases reconciled work', () => {
        const command = {trackerId: 'target-1', scopes: ['rotator'], action: 'stop', status: 'sending'};
        const props = {trackerId: 'target-1', scope: 'rotator', commands: {stop: command}};
        const {result, rerender} = renderHook(useHardwareCommand, {initialProps: props});
        expect(result.current.busy).toBe(true);
        expect(result.current.isPending('stopped')).toBe(true);
        expect(result.current.isPending('connected')).toBe(false);
        rerender({...props, commands: {stop: {...command, status: 'unknown'}}});
        expect(result.current.busy).toBe(true);
        expect(result.current.isPending('stopped')).toBe(false);
        rerender({...props, commands: {stop: {...command, status: 'unknown', reconciled: true}}});
        expect(result.current.busy).toBe(false);
    });
});
