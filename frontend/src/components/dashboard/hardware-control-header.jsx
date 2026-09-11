import {Box, Grid, Typography} from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import {useTranslation} from 'react-i18next';
import {commandLabel, isCommandSpinning} from '../target/tracker-command-state.js';
import {TrackerCommandHeaderStatus} from '../target/tracker-command-feedback.jsx';

export default function HardwareControlHeader({device, emptyLabel, connected, status, ledColor, tone, command, stale, lastUpdateAge}) {
    const {t} = useTranslation('common');
    const spinning = isCommandSpinning(command);
    const Icon = spinning ? AutorenewIcon
        : command?.status === 'succeeded' ? CheckCircleOutlineIcon
        : ['failed', 'unknown'].includes(command?.status) ? ErrorOutlineIcon : MoreHorizIcon;
    const iconColor = spinning ? 'info.main'
        : command?.status === 'succeeded' ? 'success.main'
        : command?.status === 'failed' ? 'error.main'
        : command?.status === 'unknown' ? 'warning.main' : 'text.disabled';
    const background = theme => {
        if (!connected) return `linear-gradient(135deg, ${theme.palette.overlay.light} 0%, ${theme.palette.overlay.main} 100%)`;
        if (tone) return `linear-gradient(135deg, ${theme.palette[tone].main}26 0%, ${theme.palette[tone].main}0D 100%)`;
        return `linear-gradient(135deg, ${theme.palette.action.disabledBackground} 0%, ${theme.palette.action.hover} 100%)`;
    };
    return <Grid size={{xs: 12, sm: 12, md: 12}} sx={{px: 1.5, py: 1.05, background, borderBottom: '1px solid', borderColor: 'divider'}}>
        <Box title={`${device ? `${device.name} (${device.host}:${device.port})` : emptyLabel} | `
            + `Socket ${connected ? 'Online' : 'Offline'} | Updated ${lastUpdateAge}s | `
            + `Cmd ${commandLabel(command) || t('common.not_available', {defaultValue: 'N/A'})}`}
            sx={{display: 'flex', flexDirection: 'column', gap: 0.45, minWidth: 0}}>
            <Box sx={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', minWidth: 0, gap: 0.7}}>
                <Box sx={{display: 'inline-flex', alignItems: 'center', minWidth: 0}}>
                    <Box sx={{width: 9, height: 9, borderRadius: '50%', mr: 0.8, flexShrink: 0, bgcolor: ledColor}} />
                    <Box sx={{minWidth: 0}}>
                        <Typography variant="caption" noWrap sx={{display: 'block', fontWeight: 800, fontSize: '0.72rem', lineHeight: 1.1}}>
                            {device ? device.name : emptyLabel}
                        </Typography>
                        <TrackerCommandHeaderStatus command={command} hardwareStatus={status} stale={stale} />
                    </Box>
                </Box>
                <Box sx={{display: 'inline-flex', alignItems: 'center', gap: 0.4, flexShrink: 0}}>
                    <Icon sx={{fontSize: '0.8rem', color: iconColor,
                        animation: spinning ? 'command-spin 1s linear infinite' : 'none',
                        '@keyframes command-spin': {to: {transform: 'rotate(360deg)'}},
                        '@media (prefers-reduced-motion: reduce)': {animation: 'none'},
                    }} />
                    <Typography variant="caption" sx={{fontSize: '0.62rem', color: 'text.secondary'}}>{`${lastUpdateAge}s`}</Typography>
                </Box>
            </Box>
        </Box>
    </Grid>;
}
