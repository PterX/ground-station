import React from 'react';
import {Tooltip, Typography} from '@mui/material';
import {commandLabel, isCommandOutstanding, isCommandSpinning} from './tracker-command-state.js';

const COMPLETION_DISPLAY_MS = 3000;

export function TrackerCommandHeaderStatus({command, hardwareStatus, stale = false, sx = {}}) {
    const [, refresh] = React.useReducer(value => value + 1, 0);
    const completedAt = command?.updatedAt ?? (command?.updated_at * 1000);
    const completionDeadline = completedAt + COMPLETION_DISPLAY_MS;
    React.useEffect(() => {
        if (command?.status !== 'succeeded') return;
        const remaining = completionDeadline - Date.now();
        if (!(remaining > 0)) return;
        // Expire from the recorded result time, so telemetry updates and
        // reopening the dialog cannot restart an old completion message.
        const timer = window.setTimeout(refresh, remaining);
        return () => window.clearTimeout(timer);
    }, [command?.status, completionDeadline]);

    const feedback = commandLabel(command);
    const hardwareLabel = stale ? 'Hardware status unavailable' : hardwareStatus;
    const actionName = ({move: 'Move', stop: 'Stop', park: 'Park', connect: 'Connect',
        disconnect: 'Disconnect', track: 'Tracking'})[command?.action] || 'Command';
    const unresolved = command?.status === 'unknown' && !command.reconciled;
    const unconfirmedStop = command?.status === 'unknown' && command.action === 'stop';
    let label = hardwareLabel;
    if (command?.status === 'failed') label = `${actionName} failed`;
    else if (unconfirmedStop) label = 'Stop unconfirmed';
    else if (unresolved) label = 'Status unknown';
    else if (command?.status === 'cancelled') label = `${actionName} cancelled`;
    else if (isCommandSpinning(command)) label = feedback;
    else if (!stale && command?.status === 'succeeded' && Date.now() < completionDeadline) label = feedback;

    const details = [`Hardware: ${hardwareLabel}`, feedback && `Last command: ${feedback}`,
        command?.reason && command.reason !== feedback ? command.reason : null].filter(Boolean).join(' · ');
    const color = command?.status === 'failed' ? 'error.main'
        : stale || unresolved || unconfirmedStop ? 'warning.main'
        : isCommandOutstanding(command) ? 'info.main' : 'text.secondary';

    // Reuse the existing status line. Long errors stay accessible without
    // wrapping or changing the controls' height.
    return <Tooltip title={details} describeChild enterTouchDelay={0}>
        <Typography variant="caption" noWrap tabIndex={0} role="status" aria-atomic="true"
            sx={{display: 'block', color, fontSize: '0.62rem', lineHeight: 1.1, ...sx}}>
            {label}
        </Typography>
    </Tooltip>;
}
