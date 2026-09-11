import React from 'react';
import {Tooltip, Typography} from '@mui/material';
import {commandLabel, COMMAND_BUSY} from './tracker-command-state.js';

export function TrackerCommandHeaderStatus({command, hardwareStatus, stale = false, sx = {}}) {
    const feedback = commandLabel(command);
    const status = stale ? 'Hardware status unavailable' : hardwareStatus;
    const label = feedback ? `${status} · ${feedback}` : status;
    const color = command?.status === 'failed' ? 'error.main'
        : stale || command?.status === 'unknown' ? 'warning.main'
        : COMMAND_BUSY.includes(command?.status) ? 'info.main' : 'text.secondary';

    // Reuse the existing status line. Long errors stay accessible without
    // wrapping or changing the controls' height.
    return <Tooltip title={label} enterTouchDelay={0}>
        <Typography variant="caption" noWrap tabIndex={0} role="status" aria-atomic="true"
            sx={{display: 'block', color, fontSize: '0.62rem', lineHeight: 1.1, ...sx}}>
            {label}
        </Typography>
    </Tooltip>;
}
