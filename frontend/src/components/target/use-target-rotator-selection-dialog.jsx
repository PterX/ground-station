import * as React from 'react';
import {
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    Stack,
    Typography,
} from '@mui/material';
import { useSelector } from 'react-redux';
import { Trans, useTranslation } from 'react-i18next';
import { DEFAULT_TRACKER_ID, resolveTrackerId } from './tracking-constants.js';

const RETARGET_ACTIONS = Object.freeze({
    CURRENT_SLOT: 'retarget_current_slot',
    NEW_SLOT: 'create_new_slot',
});

const normalizeHardwareId = (candidate) => {
    if (typeof candidate === 'string') {
        const normalized = candidate.trim();
        return normalized && normalized !== 'none' ? normalized : 'none';
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return String(candidate);
    }
    return 'none';
};
const normalizeRotatorId = normalizeHardwareId;
const normalizeRigId = normalizeHardwareId;
const TARGET_SLOT_ID_PATTERN = /^target-(\d+)$/;

const parseTargetSlotNumber = (trackerId = '') => {
    const matched = String(trackerId || '').match(TARGET_SLOT_ID_PATTERN);
    if (!matched) {
        return null;
    }
    const parsedNumber = Number(matched[1]);
    return Number.isFinite(parsedNumber) && parsedNumber > 0 ? parsedNumber : null;
};

const deriveNextTrackerSlotId = (rows = []) => {
    const usedTargetNumbers = new Set();
    rows.forEach((row) => {
        const targetNumber = parseTargetSlotNumber(row?.trackerId);
        if (targetNumber !== null) {
            usedTargetNumbers.add(targetNumber);
        }
    });
    let nextTargetNumber = 1;
    while (usedTargetNumbers.has(nextTargetNumber)) {
        nextTargetNumber += 1;
    }
    return `target-${nextTargetNumber}`;
};

export function useTargetRotatorSelectionDialog() {
    const { t } = useTranslation('target');
    const rotators = useSelector((state) => state.rotators?.rotators || []);
    const rigs = useSelector((state) => state.rigs?.rigs || []);
    const trackerInstances = useSelector((state) => state.trackerInstances?.instances || []);
    const activeTrackerId = useSelector((state) => state.targetSatTrack?.trackerId || DEFAULT_TRACKER_ID);
    const selectedRotator = useSelector((state) => state.targetSatTrack?.selectedRotator || 'none');
    const selectedRadioRig = useSelector((state) => state.targetSatTrack?.selectedRadioRig || 'none');
    const trackerViews = useSelector((state) => state.targetSatTrack?.trackerViews || {});

    const [open, setOpen] = React.useState(false);
    const [pendingSatelliteName, setPendingSatelliteName] = React.useState('');
    const [pendingErrorMessage, setPendingErrorMessage] = React.useState('');
    const [submitting, setSubmitting] = React.useState(false);
    const [pendingAction, setPendingAction] = React.useState(RETARGET_ACTIONS.CURRENT_SLOT);
    const [pendingAssignment, setPendingAssignment] = React.useState({
        trackerId: DEFAULT_TRACKER_ID,
        rotatorId: 'none',
        rigId: 'none',
    });
    const resolverRef = React.useRef(null);
    const submitHandlerRef = React.useRef(null);

    const closeWithResult = React.useCallback((result) => {
        const resolve = resolverRef.current;
        resolverRef.current = null;
        submitHandlerRef.current = null;
        setOpen(false);
        setPendingSatelliteName('');
        setPendingErrorMessage('');
        setSubmitting(false);
        setPendingAction(RETARGET_ACTIONS.CURRENT_SLOT);
        setPendingAssignment({ trackerId: DEFAULT_TRACKER_ID, rotatorId: 'none', rigId: 'none' });
        if (typeof resolve === 'function') {
            resolve(result);
        }
    }, []);

    const usageRows = React.useMemo(() => {
        const rotatorNameById = rotators.reduce((mapping, rotator) => {
            mapping[String(rotator.id)] = rotator.name;
            return mapping;
        }, {});
        return trackerInstances
            .map((instance) => {
                const trackerId = resolveTrackerId(instance?.tracker_id, DEFAULT_TRACKER_ID);
                if (!trackerId) {
                    return null;
                }
                const targetNumber = parseTargetSlotNumber(trackerId);
                if (targetNumber === null) {
                    return null;
                }
                const trackingState = instance?.tracking_state || {};
                const trackerView = trackerViews?.[trackerId] || {};
                const viewRotatorData = trackerView?.rotatorData || {};
                const viewTrackingState = trackerView?.trackingState || trackingState || {};
                const satName = String(trackerView?.satelliteData?.details?.name || '').trim() || null;
                const rotatorId = normalizeRotatorId(
                    trackerView?.selectedRotator
                    ?? instance?.rotator_id
                    ?? trackingState?.rotator_id
                    ?? 'none'
                );

                let statusLabel = 'unknown';
                let statusColor = 'default';
                if (rotatorId === 'none') {
                    statusLabel = 'unassigned';
                    statusColor = 'default';
                } else if (
                    viewRotatorData?.connected === false
                    || viewTrackingState?.rotator_state === 'disconnected'
                ) {
                    statusLabel = 'disconnected';
                    statusColor = 'error';
                } else if (
                    viewRotatorData?.tracking === true
                    || viewTrackingState?.rotator_state === 'tracking'
                ) {
                    statusLabel = 'tracking';
                    statusColor = 'success';
                } else if (viewRotatorData?.slewing === true) {
                    statusLabel = 'slewing';
                    statusColor = 'warning';
                } else if (
                    viewRotatorData?.parked === true
                    || viewTrackingState?.rotator_state === 'parked'
                ) {
                    statusLabel = 'parked';
                    statusColor = 'warning';
                } else if (
                    viewRotatorData?.stopped === true
                    || viewTrackingState?.rotator_state === 'stopped'
                ) {
                    statusLabel = 'stopped';
                    statusColor = 'info';
                } else if (
                    viewRotatorData?.connected === true
                    || viewTrackingState?.rotator_state === 'connected'
                ) {
                    statusLabel = 'connected';
                    statusColor = 'success';
                }

                return {
                    trackerId,
                    targetNumber,
                    rotatorId,
                    rotatorName: rotatorNameById[rotatorId] || null,
                    noradId: trackingState?.norad_id ?? null,
                    satName,
                    statusLabel,
                    statusColor,
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.targetNumber - b.targetNumber);
    }, [rotators, trackerInstances, trackerViews]);

    const resolveAssignmentForRetarget = React.useCallback(() => {
        const normalizedActiveTrackerId = resolveTrackerId(activeTrackerId, DEFAULT_TRACKER_ID);
        const fallbackTrackerId = resolveTrackerId(usageRows[0]?.trackerId, DEFAULT_TRACKER_ID);
        // Retarget should stay on the active tracker; when that is missing, fall back to the first target slot.
        const trackerId = normalizedActiveTrackerId || fallbackTrackerId || DEFAULT_TRACKER_ID;
        const trackerInstance = trackerInstances.find(
            (instance) => resolveTrackerId(instance?.tracker_id, DEFAULT_TRACKER_ID) === trackerId
        ) || null;
        const trackerView = trackerViews?.[trackerId] || {};
        // Keep the tracker's existing rotator assignment, including "none".
        const rotatorId = normalizeRotatorId(
            trackerView?.selectedRotator
            ?? trackerInstance?.rotator_id
            ?? trackerInstance?.tracking_state?.rotator_id
            ?? selectedRotator
        );
        const rigId = normalizeRigId(
            trackerView?.selectedRadioRig
            ?? trackerInstance?.rig_id
            ?? trackerInstance?.tracking_state?.rig_id
            ?? selectedRadioRig
        );
        return { trackerId, rotatorId, rigId };
    }, [activeTrackerId, selectedRadioRig, selectedRotator, trackerInstances, trackerViews, usageRows]);

    const requestRotatorForTarget = React.useCallback((satelliteName = '', options = {}) => {
        return new Promise((resolve) => {
            resolverRef.current = resolve;
            submitHandlerRef.current = typeof options?.onSubmit === 'function' ? options.onSubmit : null;
            setPendingSatelliteName(satelliteName || '');
            setPendingErrorMessage(String(options?.errorMessage || '').trim());
            setSubmitting(false);
            setPendingAction(RETARGET_ACTIONS.CURRENT_SLOT);
            setPendingAssignment(resolveAssignmentForRetarget());
            setOpen(true);
        });
    }, [resolveAssignmentForRetarget]);

    const nextTargetSlotId = React.useMemo(() => deriveNextTrackerSlotId(usageRows), [usageRows]);
    const canConfirm = pendingAction === RETARGET_ACTIONS.NEW_SLOT
        ? Boolean(nextTargetSlotId)
        : Boolean(resolveTrackerId(pendingAssignment?.trackerId, DEFAULT_TRACKER_ID));
    const satelliteLabel = pendingSatelliteName || t('target_retarget_dialog.this_satellite', { defaultValue: 'this satellite' });
    const targetNumber = parseTargetSlotNumber(pendingAssignment?.trackerId || '');
    const targetLabel = targetNumber != null
        ? t('target_retarget_dialog.target_number', { defaultValue: `Target ${targetNumber}`, number: targetNumber })
        : t('target_retarget_dialog.active_target', { defaultValue: 'the active target' });
    const newTargetLabel = t(
        'target_retarget_dialog.new_target_slot',
        { defaultValue: `New target (${nextTargetSlotId})`, slot: nextTargetSlotId },
    );
    const rotatorId = normalizeRotatorId(pendingAssignment?.rotatorId);
    const selectedRotatorName = rotatorId === 'none'
        ? t('target_retarget_dialog.no_rotator', { defaultValue: 'No rotator control' })
        : (rotators.find((rotator) => String(rotator.id) === String(rotatorId))?.name || rotatorId);
    const rigId = normalizeRigId(pendingAssignment?.rigId);
    const selectedRigName = rigId === 'none'
        ? t('target_retarget_dialog.no_rig', { defaultValue: 'No rig control' })
        : (rigs.find((rig) => String(rig.id) === String(rigId))?.name || rigId);
    const currentTrackerId = resolveTrackerId(pendingAssignment?.trackerId, DEFAULT_TRACKER_ID);
    const currentTrackerView = trackerViews?.[currentTrackerId] || {};
    const currentTrackerInstance = trackerInstances.find(
        (instance) => resolveTrackerId(instance?.tracker_id, DEFAULT_TRACKER_ID) === currentTrackerId
    ) || null;
    const currentTrackingState = currentTrackerView?.trackingState || currentTrackerInstance?.tracking_state || {};
    const currentRigData = currentTrackerView?.rigData || {};
    const isCurrentRigConnected = rigId !== 'none'
        && (
            currentRigData?.connected === true
            || ['connected', 'tracking', 'stopped'].includes(String(currentTrackingState?.rig_state || ''))
        );

    const dialog = (
        <Dialog
            open={open}
            onClose={() => {
                if (submitting) return;
                closeWithResult(null);
            }}
            fullWidth
            maxWidth="sm"
            PaperProps={{
                sx: {
                    bgcolor: 'background.paper',
                    border: (theme) => `1px solid ${theme.palette.divider}`,
                    borderRadius: 2,
                },
            }}
        >
            <DialogTitle
                sx={{
                    bgcolor: 'background.paper',
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    fontSize: '1.2rem',
                    fontWeight: 'bold',
                    py: 2.2,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
                            {t('target_retarget_dialog.title', { defaultValue: 'Retarget Satellite' })}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.2 }}>
                            {t('target_retarget_dialog.subtitle', { defaultValue: 'Choose to retarget the active slot or create a new one' })}
                        </Typography>
                    </Box>
                </Box>
            </DialogTitle>
            <DialogContent sx={{ bgcolor: 'background.paper', px: 3, pb: 2.5, pt: 5 }}>
                <Box sx={{ display: 'grid', gap: 1.25, pt: 2 }}>
                    <Box
                        sx={{
                            p: 1.25,
                            borderRadius: 1.5,
                            background: (theme) => `linear-gradient(135deg, ${theme.palette.primary.main}1A 0%, ${theme.palette.primary.main}08 100%)`,
                        }}
                    >
                        <DialogContentText sx={{ mt: 0.4, mb: 1, color: 'text.secondary' }}>
                            <Trans
                                ns="target"
                                i18nKey="target_retarget_dialog.description"
                                defaults="Choose where to apply <satellite>{{satellite}}</satellite>: retarget <target>{{target}}</target> or create a new target slot."
                                values={{ satellite: satelliteLabel, target: targetLabel }}
                                components={{ satellite: <strong />, target: <strong /> }}
                            />
                        </DialogContentText>
                        <Stack spacing={1}>
                            <Button
                                variant="outlined"
                                color="inherit"
                                onClick={() => {
                                    if (submitting) return;
                                    setPendingAction(RETARGET_ACTIONS.CURRENT_SLOT);
                                    if (pendingErrorMessage) {
                                        setPendingErrorMessage('');
                                    }
                                }}
                                fullWidth
                                disabled={submitting}
                                sx={{
                                    justifyContent: 'flex-start',
                                    textTransform: 'none',
                                    alignItems: 'stretch',
                                    px: 1.35,
                                    py: 1.2,
                                    minHeight: 104,
                                    borderRadius: 1.6,
                                    borderWidth: 1.5,
                                    color: 'text.primary',
                                    borderColor: (theme) => pendingAction === RETARGET_ACTIONS.CURRENT_SLOT
                                        ? theme.palette.primary.main
                                        : (theme.palette.mode === 'dark' ? 'grey.700' : 'grey.400'),
                                    bgcolor: (theme) => pendingAction === RETARGET_ACTIONS.CURRENT_SLOT
                                        ? (theme.palette.mode === 'dark' ? 'rgba(25, 118, 210, 0.18)' : 'rgba(25, 118, 210, 0.08)')
                                        : 'background.paper',
                                    boxShadow: (theme) => pendingAction === RETARGET_ACTIONS.CURRENT_SLOT
                                        ? (theme.palette.mode === 'dark'
                                            ? '0 6px 18px rgba(0, 0, 0, 0.45)'
                                            : '0 6px 16px rgba(15, 23, 42, 0.16)')
                                        : (theme.palette.mode === 'dark'
                                            ? '0 1px 4px rgba(0, 0, 0, 0.35)'
                                            : '0 1px 3px rgba(15, 23, 42, 0.10)'),
                                    transition: 'border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease, transform 120ms ease',
                                    '&:hover': {
                                        borderColor: (theme) => pendingAction === RETARGET_ACTIONS.CURRENT_SLOT
                                            ? theme.palette.primary.main
                                            : (theme.palette.mode === 'dark' ? 'grey.600' : 'grey.500'),
                                        bgcolor: (theme) => pendingAction === RETARGET_ACTIONS.CURRENT_SLOT
                                            ? (theme.palette.mode === 'dark' ? 'rgba(25, 118, 210, 0.24)' : 'rgba(25, 118, 210, 0.12)')
                                            : (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'),
                                        boxShadow: (theme) => pendingAction === RETARGET_ACTIONS.CURRENT_SLOT
                                            ? (theme.palette.mode === 'dark'
                                                ? '0 8px 22px rgba(0, 0, 0, 0.5)'
                                                : '0 8px 20px rgba(15, 23, 42, 0.18)')
                                            : (theme.palette.mode === 'dark'
                                                ? '0 4px 12px rgba(0, 0, 0, 0.42)'
                                                : '0 4px 10px rgba(15, 23, 42, 0.12)'),
                                    },
                                    '&:active': { transform: 'translateY(1px)' },
                                }}
                            >
                                <Box sx={{ display: 'grid', gap: 0.55, width: '100%', minWidth: 0 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                                        <Typography variant="body2" sx={{ fontWeight: 800 }}>
                                            {t('target_retarget_dialog.option_current_title', { defaultValue: 'Retarget current slot' })}
                                        </Typography>
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            label={pendingAssignment?.trackerId ? `Slot ${pendingAssignment.trackerId}` : 'Current slot'}
                                            sx={{ height: 20, '& .MuiChip-label': { px: 0.8, fontSize: '0.68rem', fontFamily: 'monospace' } }}
                                        />
                                    </Box>
                                    <Typography
                                        variant="caption"
                                        sx={{ color: 'text.secondary', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                    >
                                        {targetLabel}
                                    </Typography>
                                    <Stack direction="row" spacing={0.6} sx={{ flexWrap: 'wrap' }}>
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            label={selectedRotatorName}
                                            sx={{ height: 20, '& .MuiChip-label': { px: 0.8, fontSize: '0.68rem' } }}
                                        />
                                        {isCurrentRigConnected && (
                                            <Chip
                                                size="small"
                                                variant="outlined"
                                                label={selectedRigName}
                                                sx={{ height: 20, '& .MuiChip-label': { px: 0.8, fontSize: '0.68rem' } }}
                                            />
                                        )}
                                    </Stack>
                                </Box>
                            </Button>
                            <Button
                                variant="outlined"
                                color="inherit"
                                onClick={() => {
                                    if (submitting) return;
                                    setPendingAction(RETARGET_ACTIONS.NEW_SLOT);
                                    if (pendingErrorMessage) {
                                        setPendingErrorMessage('');
                                    }
                                }}
                                fullWidth
                                disabled={submitting}
                                sx={{
                                    justifyContent: 'flex-start',
                                    textTransform: 'none',
                                    alignItems: 'stretch',
                                    px: 1.35,
                                    py: 1.2,
                                    minHeight: 104,
                                    borderRadius: 1.6,
                                    borderWidth: 1.5,
                                    color: 'text.primary',
                                    borderColor: (theme) => pendingAction === RETARGET_ACTIONS.NEW_SLOT
                                        ? theme.palette.primary.main
                                        : (theme.palette.mode === 'dark' ? 'grey.700' : 'grey.400'),
                                    bgcolor: (theme) => pendingAction === RETARGET_ACTIONS.NEW_SLOT
                                        ? (theme.palette.mode === 'dark' ? 'rgba(25, 118, 210, 0.18)' : 'rgba(25, 118, 210, 0.08)')
                                        : 'background.paper',
                                    boxShadow: (theme) => pendingAction === RETARGET_ACTIONS.NEW_SLOT
                                        ? (theme.palette.mode === 'dark'
                                            ? '0 6px 18px rgba(0, 0, 0, 0.45)'
                                            : '0 6px 16px rgba(15, 23, 42, 0.16)')
                                        : (theme.palette.mode === 'dark'
                                            ? '0 1px 4px rgba(0, 0, 0, 0.35)'
                                            : '0 1px 3px rgba(15, 23, 42, 0.10)'),
                                    transition: 'border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease, transform 120ms ease',
                                    '&:hover': {
                                        borderColor: (theme) => pendingAction === RETARGET_ACTIONS.NEW_SLOT
                                            ? theme.palette.primary.main
                                            : (theme.palette.mode === 'dark' ? 'grey.600' : 'grey.500'),
                                        bgcolor: (theme) => pendingAction === RETARGET_ACTIONS.NEW_SLOT
                                            ? (theme.palette.mode === 'dark' ? 'rgba(25, 118, 210, 0.24)' : 'rgba(25, 118, 210, 0.12)')
                                            : (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50'),
                                        boxShadow: (theme) => pendingAction === RETARGET_ACTIONS.NEW_SLOT
                                            ? (theme.palette.mode === 'dark'
                                                ? '0 8px 22px rgba(0, 0, 0, 0.5)'
                                                : '0 8px 20px rgba(15, 23, 42, 0.18)')
                                            : (theme.palette.mode === 'dark'
                                                ? '0 4px 12px rgba(0, 0, 0, 0.42)'
                                                : '0 4px 10px rgba(15, 23, 42, 0.12)'),
                                    },
                                    '&:active': { transform: 'translateY(1px)' },
                                }}
                            >
                                <Box sx={{ display: 'grid', gap: 0.55, width: '100%', minWidth: 0 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                                        <Typography variant="body2" sx={{ fontWeight: 800 }}>
                                            {t('target_retarget_dialog.option_new_title', { defaultValue: 'Create new target slot' })}
                                        </Typography>
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            label={`Slot ${nextTargetSlotId}`}
                                            sx={{ height: 20, '& .MuiChip-label': { px: 0.8, fontSize: '0.68rem', fontFamily: 'monospace' } }}
                                        />
                                    </Box>
                                    <Typography
                                        variant="caption"
                                        sx={{ color: 'text.secondary', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                    >
                                        {newTargetLabel}
                                    </Typography>
                                    <Stack direction="row" spacing={0.6} sx={{ flexWrap: 'wrap' }}>
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            label={t('target_retarget_dialog.no_rotator', { defaultValue: 'No rotator control' })}
                                            sx={{ height: 20, '& .MuiChip-label': { px: 0.8, fontSize: '0.68rem' } }}
                                        />
                                        <Chip
                                            size="small"
                                            variant="outlined"
                                            label={t('target_retarget_dialog.no_rig', { defaultValue: 'No rig control' })}
                                            sx={{ height: 20, '& .MuiChip-label': { px: 0.8, fontSize: '0.68rem' } }}
                                        />
                                    </Stack>
                                </Box>
                            </Button>
                        </Stack>
                    </Box>

                    <Box
                        sx={{
                            p: 1.25,
                            borderRadius: 1.5,
                            background: (theme) => `linear-gradient(135deg, ${theme.palette.secondary.main}1A 0%, ${theme.palette.secondary.main}08 100%)`,
                        }}
                    >
                        {usageRows.length > 0 && (
                            <>
                                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 700 }}>
                                    {t('target_retarget_dialog.usage_overview', { defaultValue: 'Current Usage' })}
                                </Typography>
                                <Stack spacing={0.7}>
                                    {usageRows.map((row) => {
                                        const isSelectedTarget = pendingAction === RETARGET_ACTIONS.CURRENT_SLOT
                                            && row.trackerId === pendingAssignment?.trackerId;
                                        return (
                                            <Box
                                                key={row.trackerId}
                                                sx={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    px: 1,
                                                    py: 0.6,
                                                    borderRadius: 1,
                                                    bgcolor: isSelectedTarget ? 'action.selected' : 'action.hover',
                                                }}
                                            >
                                                <Typography variant="body2" sx={{ minWidth: 72, fontWeight: 700 }}>
                                                    {`Target ${row.targetNumber}`}
                                                </Typography>
                                                <Typography
                                                    variant="caption"
                                                    sx={{
                                                        flex: 1,
                                                        mx: 1,
                                                        whiteSpace: 'nowrap',
                                                        overflow: 'hidden',
                                                        textOverflow: 'ellipsis',
                                                    }}
                                                >
                                                    {row.rotatorId !== 'none'
                                                        ? `${row.rotatorName || row.rotatorId} (${row.rotatorId.slice(0, 6)})`
                                                        : 'No rotator'}
                                                </Typography>
                                                <Stack direction="row" spacing={0.6} sx={{ alignItems: 'center', minWidth: 0, maxWidth: 220 }}>
                                                    {row.noradId && row.satName ? (
                                                        <Typography
                                                            variant="caption"
                                                            sx={{
                                                                minWidth: 0,
                                                                maxWidth: 130,
                                                                whiteSpace: 'nowrap',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                color: 'text.secondary',
                                                            }}
                                                            title={row.satName}
                                                        >
                                                            {row.satName}
                                                        </Typography>
                                                    ) : null}
                                                    <Chip
                                                        size="small"
                                                        variant="outlined"
                                                        color={row.noradId ? 'success' : 'default'}
                                                        label={row.noradId ? `SAT ${row.noradId}` : 'No target'}
                                                        sx={{ height: 20, '& .MuiChip-label': { px: 0.8, fontSize: '0.68rem' } }}
                                                    />
                                                </Stack>
                                            </Box>
                                        );
                                    })}
                                </Stack>
                            </>
                        )}
                    </Box>
                </Box>
                {pendingErrorMessage && (
                    <Box
                        sx={{
                            mt: 0.75,
                            px: 1.2,
                            py: 0.9,
                            borderRadius: 1.2,
                            border: '1px solid',
                            borderColor: 'error.main',
                            bgcolor: 'error.light',
                        }}
                    >
                        <Typography
                            variant="caption"
                            sx={{ color: 'error.contrastText', fontWeight: 700, lineHeight: 1.3 }}
                        >
                            {pendingErrorMessage}
                        </Typography>
                    </Box>
                )}
            </DialogContent>
            <DialogActions
                sx={{
                    bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
                    borderTop: (theme) => `1px solid ${theme.palette.divider}`,
                    px: 3,
                    py: 2,
                    gap: 1.5,
                }}
            >
                <Button
                    variant="outlined"
                    disabled={submitting}
                    onClick={() => closeWithResult(null)}
                >
                    {t('target_retarget_dialog.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button
                    color="success"
                    variant="contained"
                    disabled={!canConfirm || submitting}
                    startIcon={submitting ? <CircularProgress color="inherit" size={16} /> : null}
                    onClick={async () => {
                        if (submitting) return;
                        const assignment = pendingAction === RETARGET_ACTIONS.NEW_SLOT
                            ? {
                                action: RETARGET_ACTIONS.NEW_SLOT,
                                trackerId: nextTargetSlotId,
                                rotatorId: 'none',
                                rigId: 'none',
                            }
                            : {
                                action: RETARGET_ACTIONS.CURRENT_SLOT,
                                trackerId: resolveTrackerId(pendingAssignment?.trackerId, DEFAULT_TRACKER_ID),
                                rotatorId,
                                rigId: normalizeRigId(pendingAssignment?.rigId),
                            };
                        const submitHandler = submitHandlerRef.current;
                        if (typeof submitHandler !== 'function') {
                            closeWithResult(assignment);
                            return;
                        }
                        try {
                            setSubmitting(true);
                            setPendingErrorMessage('');
                            const submitResult = await submitHandler(assignment);
                            if (submitResult?.success === false) {
                                setPendingErrorMessage(
                                    String(
                                        submitResult?.errorMessage
                                        || t('target_retarget_dialog.submit_failed', { defaultValue: 'Failed to apply target selection.' })
                                    ),
                                );
                                setSubmitting(false);
                                return;
                            }
                            setSubmitting(false);
                            closeWithResult(assignment);
                        } catch (error) {
                            setPendingErrorMessage(
                                String(
                                    error?.message
                                    || t('target_retarget_dialog.submit_failed', { defaultValue: 'Failed to apply target selection.' })
                                ),
                            );
                            setSubmitting(false);
                        }
                    }}
                >
                    {submitting
                        ? t('target_retarget_dialog.submitting', { defaultValue: 'Applying...' })
                        : pendingAction === RETARGET_ACTIONS.NEW_SLOT
                        ? t('target_retarget_dialog.confirm_create', { defaultValue: 'Create New Target' })
                        : t('target_retarget_dialog.confirm_retarget', { defaultValue: 'Retarget Current Slot' })}
                </Button>
            </DialogActions>
        </Dialog>
    );

    return { requestRotatorForTarget, dialog };
}
