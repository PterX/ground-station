/**
 * @license
 * Copyright (c) 2025 Efstratios Goudelis
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 */

import React, { useCallback, useState, useEffect, useMemo } from "react";
import {
    Box,
    Typography,
    Chip,
    Tooltip,
    Button,
    Tabs,
    Tab,
    IconButton,
    Autocomplete,
    TextField,
    CircularProgress,
    FormControl,
    InputLabel,
    Select,
    MenuItem,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogContentText,
    DialogActions,
} from "@mui/material";
import { useDispatch, useSelector } from "react-redux";
import { useSocket } from "../common/socket.jsx";
import { useTranslation } from 'react-i18next';
import CloseIcon from '@mui/icons-material/Close';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import LocationSearchingIcon from '@mui/icons-material/LocationSearching';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import LocalParkingIcon from '@mui/icons-material/LocalParking';
import WarningIcon from '@mui/icons-material/Warning';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import {
    setAvailableTransmitters,
    setRadioRig,
    setRotator,
    setSatelliteId,
    setTrackerId,
    setTrackingStateInBackend,
} from './target-slice.jsx';
import { toast } from "../../utils/toast-with-timestamp.jsx";
import SatelliteSearchAutocomplete from "./satellite-search.jsx";
import { useTargetRotatorSelectionDialog } from "./use-target-rotator-selection-dialog.jsx";
import { deleteTrackerInstance } from "./tracker-instances-slice.jsx";
import { cancelRunningObservation } from "../scheduler/scheduler-slice.jsx";
import { resolveTabHardwareLedStatus } from "../common/hardware-status.js";

const TARGET_SLOT_ID_PATTERN = /^target-(\d+)$/;
const ADD_TARGET_TAB_VALUE = '__add-target__';

const parseTargetSlotNumber = (trackerId = '') => {
    const match = String(trackerId || '').match(TARGET_SLOT_ID_PATTERN);
    if (!match) {
        return null;
    }
    const targetNumber = Number(match[1]);
    return Number.isFinite(targetNumber) && targetNumber > 0 ? targetNumber : null;
};

const deriveNextTrackerSlotId = (instances = []) => {
    const usedTargetNumbers = new Set();
    instances.forEach((instance) => {
        const targetNumber = parseTargetSlotNumber(instance?.tracker_id);
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

const resolveTabLedPresentation = ({ source, status, usedRigFallback }) => {
    const bySource = {
        rotator: {
            none: {
                label: 'No rotator',
                bgColor: 'action.disabled',
                borderColor: 'action.disabledBackground',
                Icon: null,
                iconColor: 'text.disabled',
            },
            disconnected: {
                label: 'Rotator disconnected',
                // Neutral gray: disconnected is not an error state.
                bgColor: 'action.disabled',
                borderColor: 'action.disabledBackground',
                Icon: CloseIcon,
                iconColor: 'text.disabled',
            },
            parked: {
                label: 'Rotator parked',
                bgColor: 'warning.main',
                borderColor: 'warning.dark',
                Icon: LocalParkingIcon,
                iconColor: 'common.white',
            },
            outofbounds: {
                label: 'Rotator out of bounds',
                bgColor: 'secondary.main',
                borderColor: 'secondary.dark',
                Icon: WarningIcon,
                iconColor: 'common.white',
            },
            minelevation: {
                label: 'Below minimum elevation',
                bgColor: 'error.light',
                borderColor: 'error.main',
                Icon: ArrowDownwardIcon,
                iconColor: 'common.white',
            },
            slewing: {
                label: 'Rotator slewing',
                bgColor: 'warning.main',
                borderColor: 'warning.dark',
                Icon: PlayArrowIcon,
                iconColor: 'common.white',
            },
            tracking: {
                label: 'Rotator tracking',
                bgColor: 'success.light',
                borderColor: 'success.main',
                Icon: LocationSearchingIcon,
                iconColor: 'common.white',
            },
            stopped: {
                label: 'Rotator stopped',
                // Neutral informational state (not warning/error).
                bgColor: 'info.light',
                borderColor: 'info.main',
                Icon: PauseIcon,
                iconColor: 'common.white',
            },
            connected: {
                label: 'Rotator connected',
                bgColor: 'success.dark',
                borderColor: 'success.main',
                Icon: null,
                iconColor: 'common.white',
            },
            unknown: {
                label: 'Rotator status unknown',
                bgColor: 'action.disabled',
                borderColor: 'action.disabledBackground',
                Icon: null,
                iconColor: 'text.disabled',
            },
        },
        rig: {
            none: {
                label: 'No rig',
                bgColor: 'action.disabled',
                borderColor: 'action.disabledBackground',
                Icon: null,
                iconColor: 'text.disabled',
            },
            disconnected: {
                label: 'Rig disconnected',
                bgColor: 'action.disabled',
                borderColor: 'action.disabledBackground',
                Icon: CloseIcon,
                iconColor: 'text.disabled',
            },
            tracking: {
                label: 'Rig tracking',
                bgColor: 'success.light',
                borderColor: 'success.main',
                Icon: LocationSearchingIcon,
                iconColor: 'common.white',
            },
            stopped: {
                label: 'Rig stopped',
                bgColor: 'info.light',
                borderColor: 'info.main',
                Icon: PauseIcon,
                iconColor: 'common.white',
            },
            connected: {
                label: 'Rig connected',
                bgColor: 'success.dark',
                borderColor: 'success.main',
                Icon: null,
                iconColor: 'common.white',
            },
            unknown: {
                label: 'Rig status unknown',
                bgColor: 'action.disabled',
                borderColor: 'action.disabledBackground',
                Icon: null,
                iconColor: 'text.disabled',
            },
        },
    };

    const fallback = bySource[source]?.unknown || bySource.rig.unknown;
    const resolved = bySource[source]?.[status] || fallback;
    return {
        ...resolved,
        label: usedRigFallback ? `${resolved.label} (rig fallback)` : resolved.label,
        fallbackSource: source,
    };
};

const TargetSatelliteSelectorBar = React.memo(function TargetSatelliteSelectorBar() {
    const { socket } = useSocket();
    const dispatch = useDispatch();
    const { t } = useTranslation('target');

    const {
        trackingState,
        trackerId,
        selectedRadioRig,
        selectedTransmitter,
    } = useSelector((state) => state.targetSatTrack);
    const trackerInstances = useSelector((state) => state.trackerInstances?.instances || []);
    const schedulerObservations = useSelector((state) => state.scheduler?.observations || []);
    const rigRows = useSelector((state) => state.rigs?.rigs || []);
    const rotatorRows = useSelector((state) => state.rotators?.rotators || []);

    const trackerViews = useSelector((state) => state.targetSatTrack?.trackerViews || {});
    const { requestRotatorForTarget, dialog: rotatorSelectionDialog } = useTargetRotatorSelectionDialog();
    const [searchResetKey, setSearchResetKey] = useState(0);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [pendingDeleteTarget, setPendingDeleteTarget] = useState(null);
    const [deleteTargetBusy, setDeleteTargetBusy] = useState(false);
    const [abortDialogOpen, setAbortDialogOpen] = useState(false);
    const [pendingAbortObservation, setPendingAbortObservation] = useState(null);
    const [abortObservationBusy, setAbortObservationBusy] = useState(false);
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [createTargetBusy, setCreateTargetBusy] = useState(false);
    const [createSearchOpen, setCreateSearchOpen] = useState(false);
    const [createSearchOptions, setCreateSearchOptions] = useState([]);
    const [createSearchLoading, setCreateSearchLoading] = useState(false);
    const [createSelectedSatellite, setCreateSelectedSatellite] = useState(null);
    const [createSelectedRigId, setCreateSelectedRigId] = useState('none');
    const [createSelectedRotatorId, setCreateSelectedRotatorId] = useState('none');
    const [createDialogError, setCreateDialogError] = useState('');
    const targetTrackerInstances = useMemo(
        () => trackerInstances.filter((instance) => parseTargetSlotNumber(instance?.tracker_id) !== null),
        [trackerInstances]
    );
    const runningObservationTrackerIds = useMemo(() => {
        const running = schedulerObservations.filter((obs) => obs?.status === 'running');
        return new Set(
            running
                .map((obs) => String(obs?.id || '').trim())
                .filter((value) => value.length > 0)
        );
    }, [schedulerObservations]);
    const tabTrackerInstances = useMemo(() => {
        return trackerInstances.filter((instance) => {
            const instanceTrackerId = String(instance?.tracker_id || '').trim();
            if (!instanceTrackerId) return false;
            if (parseTargetSlotNumber(instanceTrackerId) !== null) return true;
            return runningObservationTrackerIds.has(instanceTrackerId);
        });
    }, [trackerInstances, runningObservationTrackerIds]);

    const emitTrackingErrorToast = useCallback((error, fallbackMessage, options = {}) => {
        const suppressLimitToast = Boolean(options?.suppressLimitToast);
        const suppressToast = Boolean(options?.suppressToast);
        const errorCode = String(error?.error || error?.code || '').trim();
        let message = '';
        if (errorCode === 'tracker_slot_limit_reached') {
            const limit = Number(error?.data?.limit);
            if (Number.isFinite(limit) && limit > 0) {
                message = `Target limit reached (${limit}). Delete an existing target first.`;
            } else {
                message = 'Target limit reached. Delete an existing target first.';
            }
            if (!suppressLimitToast && !suppressToast) {
                toast.error(message);
            }
            return message;
        } else {
            message = error?.message || String(error) || fallbackMessage;
        }
        if (!suppressToast) {
            toast.error(message);
        }
        return message;
    }, []);

    const handleTargetTabChange = useCallback((event, value) => {
        if (!value) return;
        if (value === ADD_TARGET_TAB_VALUE) {
            setCreateDialogOpen(true);
            return;
        }
        dispatch(setTrackerId(value));
    }, [dispatch]);

    const handleDeleteTarget = useCallback((event, targetOption) => {
        event.preventDefault();
        event.stopPropagation();
        const trackerIdToDelete = targetOption?.trackerId;
        if (!trackerIdToDelete) {
            return;
        }
        const targetNumber = Number(targetOption?.targetNumber || 0);
        const linkedRunning = (targetOption?.linkedObservations || [])
            .filter((obs) => obs?.status === 'running');
        if (targetOption?.hasActiveObservation && linkedRunning.length > 0) {
            setPendingAbortObservation(linkedRunning[0]);
            setAbortDialogOpen(true);
            return;
        }
        setPendingDeleteTarget({ trackerId: trackerIdToDelete, targetNumber });
        setDeleteDialogOpen(true);
    }, []);

    const handleConfirmAbortObservation = useCallback(async () => {
        if (!pendingAbortObservation?.id || !socket) {
            setAbortDialogOpen(false);
            setPendingAbortObservation(null);
            return;
        }
        try {
            setAbortObservationBusy(true);
            await dispatch(cancelRunningObservation({ socket, id: pendingAbortObservation.id })).unwrap();
            setAbortDialogOpen(false);
            setPendingAbortObservation(null);
            setAbortObservationBusy(false);
        } catch (error) {
            toast.error(error?.message || String(error) || 'Failed to abort observation');
            setAbortObservationBusy(false);
        }
    }, [dispatch, pendingAbortObservation, socket]);

    const handleConfirmDeleteTarget = useCallback(async () => {
        const trackerIdToDelete = pendingDeleteTarget?.trackerId;
        if (!trackerIdToDelete) {
            setDeleteDialogOpen(false);
            setPendingDeleteTarget(null);
            setDeleteTargetBusy(false);
            return;
        }
        try {
            setDeleteTargetBusy(true);
            await dispatch(deleteTrackerInstance({ socket, trackerId: trackerIdToDelete })).unwrap();
            setDeleteDialogOpen(false);
            setPendingDeleteTarget(null);
            setDeleteTargetBusy(false);
        } catch (error) {
            toast.error(error?.message || String(error) || 'Failed to delete target');
            setDeleteDialogOpen(false);
            setPendingDeleteTarget(null);
            setDeleteTargetBusy(false);
        }
    }, [dispatch, pendingDeleteTarget, socket]);

    const getTransmittersFromSatellite = useCallback((satellite) => {
        if (!satellite || typeof satellite !== 'object') {
            return [];
        }
        if (Array.isArray(satellite.transmitters)) {
            return satellite.transmitters;
        }
        return [];
    }, []);

    const resetCreateDialogState = useCallback(() => {
        setCreateSearchOpen(false);
        setCreateSearchOptions([]);
        setCreateSearchLoading(false);
        setCreateSelectedSatellite(null);
        setCreateSelectedRigId('none');
        setCreateSelectedRotatorId('none');
        setCreateDialogError('');
        setCreateTargetBusy(false);
    }, []);

    const handleOpenCreateDialog = useCallback(() => {
        setCreateDialogOpen(true);
    }, []);

    const handleCloseCreateDialog = useCallback(() => {
        if (createTargetBusy) return;
        setCreateDialogOpen(false);
        resetCreateDialogState();
    }, [createTargetBusy, resetCreateDialogState]);

    const handleCreateSearchInputChange = useCallback((event, value) => {
        const keyword = String(value || '').trim();
        if (keyword.length < 3) {
            setCreateSearchOptions([]);
            setCreateSearchLoading(false);
            return;
        }
        setCreateSearchLoading(true);
        socket.emit('data_request', 'get-satellite-search', keyword, (response) => {
            if (response?.success) {
                setCreateSearchOptions(Array.isArray(response?.data) ? response.data : []);
            } else {
                setCreateSearchOptions([]);
                toast.error(response?.error || 'Error searching for satellites');
            }
            setCreateSearchLoading(false);
        });
    }, [socket]);

    const handleCreateTargetSubmit = useCallback(async () => {
        setCreateDialogError('');
        if (!createSelectedSatellite?.norad_id) {
            toast.error('Please select a satellite first');
            return;
        }

        const selectedGroupId = createSelectedSatellite?.groups?.[0]?.id || trackingState?.group_id || '';
        if (!selectedGroupId) {
            toast.error('Selected satellite has no group mapping');
            return;
        }

        const trackerSlotId = deriveNextTrackerSlotId(targetTrackerInstances);
        const normalizedRigId = createSelectedRigId || 'none';
        const normalizedRotatorId = createSelectedRotatorId || 'none';
        const nextTransmitters = getTransmittersFromSatellite(createSelectedSatellite);

        // New targets must always start disconnected, regardless of the currently active target state.
        const payload = {
            tracker_id: trackerSlotId,
            norad_id: createSelectedSatellite.norad_id,
            group_id: selectedGroupId,
            rig_id: normalizedRigId,
            rotator_id: normalizedRotatorId,
            transmitter_id: 'none',
            rig_state: 'disconnected',
            rotator_state: 'disconnected',
            rig_vfo: 'none',
            vfo1: 'uplink',
            vfo2: 'downlink',
        };

        try {
            setCreateTargetBusy(true);
            dispatch(setTrackerId(trackerSlotId));
            dispatch(setSatelliteId(createSelectedSatellite.norad_id));
            dispatch(setRotator({ value: normalizedRotatorId, trackerId: trackerSlotId }));
            dispatch(setRadioRig({ value: normalizedRigId, trackerId: trackerSlotId }));
            dispatch(setAvailableTransmitters(nextTransmitters));
            await dispatch(setTrackingStateInBackend({ socket, data: payload })).unwrap();
            setCreateDialogOpen(false);
            resetCreateDialogState();
        } catch (error) {
            const errorMessage = emitTrackingErrorToast(
                error,
                'Failed to create target',
                { suppressLimitToast: true },
            );
            setCreateDialogError(String(errorMessage || 'Failed to create target'));
            setCreateTargetBusy(false);
        }
    }, [
        createSelectedRigId,
        createSelectedRotatorId,
        createSelectedSatellite,
        dispatch,
        emitTrackingErrorToast,
        getTransmittersFromSatellite,
        resetCreateDialogState,
        socket,
        targetTrackerInstances,
        trackingState,
    ]);

    const handleRetargetSatelliteSelect = useCallback(async (satellite) => {
        if (!satellite?.norad_id) {
            return;
        }

        await requestRotatorForTarget(satellite?.name, {
            onSubmit: async (selectedAssignment) => {
                if (!selectedAssignment) {
                    return { success: false };
                }
            const assignmentAction = String(selectedAssignment?.action || 'retarget_current_slot');
            const isCreateNewSlot = assignmentAction === 'create_new_slot';
            const selectedTrackerId = String(selectedAssignment?.trackerId || '');
            const rotatorId = String(selectedAssignment?.rotatorId || 'none');
            const assignmentRigId = String(selectedAssignment?.rigId || 'none');
            if (!selectedTrackerId) {
                    return { success: false, errorMessage: 'Missing target tracker slot.' };
            }
            const selectedGroupId = satellite?.groups?.[0]?.id || trackingState?.group_id || "";
            const nextTransmitters = getTransmittersFromSatellite(satellite);
            const nextRigId = isCreateNewSlot ? assignmentRigId : selectedRadioRig;
            const nextRotatorId = isCreateNewSlot ? 'none' : rotatorId;
            const nextTransmitterId = isCreateNewSlot ? 'none' : selectedTransmitter;

            const data = isCreateNewSlot
                ? {
                    tracker_id: selectedTrackerId,
                    norad_id: satellite.norad_id,
                    group_id: selectedGroupId,
                    rig_id: nextRigId,
                    rotator_id: nextRotatorId,
                    transmitter_id: 'none',
                    rig_state: 'disconnected',
                    rotator_state: 'disconnected',
                    rig_vfo: 'none',
                    vfo1: 'uplink',
                    vfo2: 'downlink',
                }
                : {
                    ...trackingState,
                    tracker_id: selectedTrackerId,
                    norad_id: satellite.norad_id,
                    group_id: selectedGroupId,
                    rig_id: nextRigId,
                    rotator_id: nextRotatorId,
                    transmitter_id: nextTransmitterId,
                };

            try {
                await dispatch(setTrackingStateInBackend({ socket, data })).unwrap();
                dispatch(setTrackerId(selectedTrackerId));
                dispatch(setSatelliteId(satellite.norad_id));
                dispatch(setRotator({ value: nextRotatorId, trackerId: selectedTrackerId }));
                dispatch(setRadioRig({ value: nextRigId, trackerId: selectedTrackerId }));
                dispatch(setAvailableTransmitters(nextTransmitters));
                setSearchResetKey((value) => value + 1);
                    return { success: true };
            } catch (error) {
                const errorCode = String(error?.error || error?.code || '').trim();
                if (errorCode === 'tracker_slot_limit_reached') {
                        const limitMessage = emitTrackingErrorToast(
                        error,
                        'Failed to set target',
                        { suppressLimitToast: true, suppressToast: true },
                    );
                        return { success: false, errorMessage: limitMessage };
                }
                    const message = emitTrackingErrorToast(error, 'Failed to set target');
                    return { success: false, errorMessage: message };
            }
            },
        });
    }, [
        dispatch,
        emitTrackingErrorToast,
        getTransmittersFromSatellite,
        requestRotatorForTarget,
        selectedRadioRig,
        selectedTransmitter,
        socket,
        trackingState,
    ]);

    const targetOptions = useMemo(() => tabTrackerInstances.map((instance, index) => {
        const instanceTrackerId = instance?.tracker_id || '';
        const parsedTargetNumber = parseTargetSlotNumber(instanceTrackerId);
        const targetNumber = parsedTargetNumber != null ? Number(parsedTargetNumber) : null;
        const isObservationTracker = parsedTargetNumber == null;
        const view = trackerViews?.[instanceTrackerId] || {};
        const effectiveTrackingState = view?.trackingState || instance?.tracking_state || {};
        const rotatorData = view?.rotatorData || {};
        const rigData = view?.rigData || {};
        const satName = view?.satelliteData?.details?.name || 'No satellite';
        const satNorad = effectiveTrackingState?.norad_id || 'none';
        const rotatorId = view?.selectedRotator || instance?.rotator_id || effectiveTrackingState?.rotator_id || 'none';
        const rigId = view?.selectedRadioRig || instance?.rig_id || effectiveTrackingState?.rig_id || 'none';
        const rotatorName = String(rotatorId) === 'none'
            ? 'No rotator'
            : (rotatorRows.find((row) => String(row.id) === String(rotatorId))?.name || String(rotatorId));
        const isTracking = Boolean(rigData?.tracking || rotatorData?.tracking);
        const satAz = Number.isFinite(view?.satelliteData?.position?.az) ? view.satelliteData.position.az : null;
        const satEl = Number.isFinite(view?.satelliteData?.position?.el) ? view.satelliteData.position.el : null;
        const tabHardwareLedStatus = resolveTabHardwareLedStatus({
            rotatorId,
            rigId,
            rotatorData,
            rigData,
            trackingState: effectiveTrackingState,
        });
        const tabHardwareLed = {
            source: tabHardwareLedStatus.source,
            status: tabHardwareLedStatus.status,
            ...resolveTabLedPresentation(tabHardwareLedStatus),
        };
        const linkedObservations = schedulerObservations
            .filter((obs) => obs?.enabled)
            .filter((obs) => {
                const obsRotatorId = String(obs?.rotator?.id || obs?.rotator_id || 'none');
                const obsNorad = String(obs?.satellite?.norad_id || 'none');
                if (obsRotatorId !== 'none' && String(rotatorId) !== 'none') {
                    return obsRotatorId === String(rotatorId);
                }
                if (obsNorad !== 'none' && String(satNorad) !== 'none') {
                    return obsNorad === String(satNorad);
                }
                return false;
            });
        const runningObs = linkedObservations.filter((obs) => obs?.status === 'running');
        const upcomingObs = linkedObservations.filter((obs) => obs?.status === 'scheduled');
        return {
            trackerId: instanceTrackerId,
            targetNumber,
            isObservationTracker,
            satName,
            satNorad,
            rotatorId,
            rigId,
            rotatorName,
            isTracking,
            tabHardwareLed,
            satAz,
            satEl,
            runningObsCount: runningObs.length,
            upcomingObsCount: upcomingObs.length,
            hasActiveObservation: runningObs.length > 0,
            hasScheduledObservation: upcomingObs.length > 0,
            linkedObservations,
        };
    }), [tabTrackerInstances, trackerViews, schedulerObservations, rotatorRows]);

    const tabValue = targetOptions.some((option) => option.trackerId === trackerId)
        ? trackerId
        : (targetOptions[0]?.trackerId || false);
    const activeTargetOption = useMemo(
        () => targetOptions.find((option) => option.trackerId === tabValue) || null,
        [targetOptions, tabValue]
    );
    const disableRetargetSearch = Boolean(activeTargetOption?.hasActiveObservation);
    const nextTargetSlotId = useMemo(
        () => deriveNextTrackerSlotId(targetTrackerInstances),
        [targetTrackerInstances]
    );
    const hardwareUsageRows = useMemo(() => {
        return trackerInstances.map((instance, index) => {
            const instanceTrackerId = String(instance?.tracker_id || '');
            const targetNumber = Number(instance?.target_number || (index + 1));
            const tracking = instance?.tracking_state || {};
            return {
                trackerId: instanceTrackerId,
                targetNumber,
                rigId: String(tracking?.rig_id || 'none'),
                rotatorId: String(instance?.rotator_id || tracking?.rotator_id || 'none'),
            };
        });
    }, [trackerInstances]);
    const rigUsageById = useMemo(() => {
        return hardwareUsageRows.reduce((acc, row) => {
            if (!row.rigId || row.rigId === 'none') return acc;
            if (!acc[row.rigId]) acc[row.rigId] = [];
            acc[row.rigId].push(row);
            return acc;
        }, {});
    }, [hardwareUsageRows]);
    const rotatorUsageById = useMemo(() => {
        return hardwareUsageRows.reduce((acc, row) => {
            if (!row.rotatorId || row.rotatorId === 'none') return acc;
            if (!acc[row.rotatorId]) acc[row.rotatorId] = [];
            acc[row.rotatorId].push(row);
            return acc;
        }, {});
    }, [hardwareUsageRows]);

    return (
        <>
        {rotatorSelectionDialog}
        <Dialog
            open={deleteDialogOpen}
            onClose={() => {
                if (deleteTargetBusy) return;
                setDeleteDialogOpen(false);
                setPendingDeleteTarget(null);
                setDeleteTargetBusy(false);
            }}
            fullWidth
            maxWidth="xs"
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
                    bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
                    borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
                    fontSize: '1.1rem',
                    fontWeight: 'bold',
                    py: 2,
                }}
            >
                Delete Target
            </DialogTitle>
            <DialogContent sx={{ bgcolor: 'background.paper', px: 3, pb: 2.5 }}>
                <Box sx={{ pt: 2 }}>
                    <DialogContentText sx={{ mb: 1 }}>
                        {`Delete ${pendingDeleteTarget ? `Target ${pendingDeleteTarget.targetNumber}` : 'this target'}?`}
                    </DialogContentText>
                    <DialogContentText color="text.secondary">
                        This will remove the target tracking state and stop its tracker process.
                    </DialogContentText>
                    {deleteTargetBusy && (
                        <Box sx={{ mt: 1.2, display: 'flex', alignItems: 'center', gap: 1 }}>
                            <CircularProgress size={16} />
                            <Typography variant="caption" color="text.secondary">
                                Deleting target...
                            </Typography>
                        </Box>
                    )}
                </Box>
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
                    disabled={deleteTargetBusy}
                    onClick={() => {
                        setDeleteDialogOpen(false);
                        setPendingDeleteTarget(null);
                        setDeleteTargetBusy(false);
                    }}
                >
                    Cancel
                </Button>
                <Button
                    color="error"
                    variant="contained"
                    disabled={deleteTargetBusy}
                    onClick={handleConfirmDeleteTarget}
                    startIcon={deleteTargetBusy ? <CircularProgress color="inherit" size={16} /> : null}
                >
                    {deleteTargetBusy ? 'Deleting...' : 'Delete'}
                </Button>
            </DialogActions>
        </Dialog>
        <Dialog
            open={abortDialogOpen}
            onClose={() => {
                if (abortObservationBusy) return;
                setAbortDialogOpen(false);
                setPendingAbortObservation(null);
            }}
            fullWidth
            maxWidth="xs"
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
                    bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
                    borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
                    fontSize: '1.1rem',
                    fontWeight: 'bold',
                    py: 2,
                }}
            >
                {pendingAbortObservation?.status === 'running' ? 'Stop Observation' : 'Abort Observation'}
            </DialogTitle>
            <DialogContent sx={{ bgcolor: 'background.paper', px: 3, pb: 2.5 }}>
                <Box sx={{ pt: 2 }}>
                    <DialogContentText sx={{ mb: 1 }}>
                        {pendingAbortObservation?.status === 'running'
                            ? <>Are you sure you want to stop the observation <strong>{pendingAbortObservation?.satellite?.name || 'Unknown'}</strong>?</>
                            : <>Are you sure you want to abort the observation <strong>{pendingAbortObservation?.satellite?.name || 'Unknown'}</strong>?</>
                        }
                    </DialogContentText>
                    <DialogContentText color="text.secondary">
                        {pendingAbortObservation?.status === 'running'
                            ? 'This will immediately stop the observation and remove all scheduled jobs.'
                            : 'This will cancel the scheduled observation and remove all scheduled jobs.'
                        }
                    </DialogContentText>
                    {abortObservationBusy && (
                        <Box sx={{ mt: 1.2, display: 'flex', alignItems: 'center', gap: 1 }}>
                            <CircularProgress size={16} />
                            <Typography variant="caption" color="text.secondary">
                                Processing observation...
                            </Typography>
                        </Box>
                    )}
                </Box>
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
                    disabled={abortObservationBusy}
                    onClick={() => {
                        setAbortDialogOpen(false);
                        setPendingAbortObservation(null);
                    }}
                >
                    Cancel
                </Button>
                <Button
                    color="error"
                    variant="contained"
                    disabled={abortObservationBusy}
                    onClick={handleConfirmAbortObservation}
                    startIcon={abortObservationBusy ? <CircularProgress color="inherit" size={16} /> : null}
                >
                    {abortObservationBusy
                        ? (pendingAbortObservation?.status === 'running' ? 'Stopping...' : 'Aborting...')
                        : (pendingAbortObservation?.status === 'running' ? 'Stop' : 'Abort')}
                </Button>
            </DialogActions>
        </Dialog>
        <Dialog
            open={createDialogOpen}
            onClose={handleCloseCreateDialog}
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
                            Add New Target
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.2 }}>
                            Configure satellite and hardware in two quick steps
                        </Typography>
                    </Box>
                    <Chip
                        size="small"
                        color="info"
                        variant="outlined"
                        label={`Slot ${nextTargetSlotId}`}
                        sx={{ fontFamily: 'monospace', fontSize: '0.68rem', fontWeight: 700 }}
                    />
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
                        <Typography variant="overline" sx={{ fontWeight: 800, color: 'primary.main', letterSpacing: 0.4 }}>
                            Step 1 · Satellite
                        </Typography>
                        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
                            Search and select the satellite target.
                        </Typography>
                    <Autocomplete
                        size="small"
                        open={createSearchOpen}
                        onOpen={() => setCreateSearchOpen(true)}
                        onClose={() => setCreateSearchOpen(false)}
                        options={createSearchOptions}
                        loading={createSearchLoading}
                        value={createSelectedSatellite}
                        onInputChange={handleCreateSearchInputChange}
                        onChange={(event, value) => {
                            setCreateSelectedSatellite(value || null);
                            if (createDialogError) {
                                setCreateDialogError('');
                            }
                        }}
                        isOptionEqualToValue={(option, value) => option?.norad_id === value?.norad_id}
                        getOptionLabel={(option) => `${option?.norad_id || ''} - ${option?.name || ''}`}
                        renderInput={(params) => (
                            <TextField
                                {...params}
                                label="Satellite"
                                placeholder="Search by name or NORAD ID"
                                slotProps={{
                                    input: {
                                        ...params.InputProps,
                                        endAdornment: (
                                            <>
                                                {createSearchLoading ? <CircularProgress color="inherit" size={18} /> : null}
                                                {params.InputProps.endAdornment}
                                            </>
                                        ),
                                    },
                                }}
                            />
                        )}
                    />
                    </Box>

                    <Box
                        sx={{
                            p: 1.25,
                            borderRadius: 1.5,
                            background: (theme) => `linear-gradient(135deg, ${theme.palette.secondary.main}1A 0%, ${theme.palette.secondary.main}08 100%)`,
                        }}
                    >
                        <Typography variant="overline" sx={{ fontWeight: 800, color: 'secondary.main', letterSpacing: 0.4 }}>
                            Step 2 · Hardware (Optional)
                        </Typography>
                        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 1 }}>
                            Assign rotator and rig now, or leave as none.
                        </Typography>

                    <FormControl
                        size="small"
                        fullWidth
                        variant="outlined"
                        sx={{ minWidth: 200, mt: 0, mb: 1 }}
                    >
                        <InputLabel id="create-target-rotator-label">Rotator</InputLabel>
                        <Select
                            labelId="create-target-rotator-label"
                            value={createSelectedRotatorId}
                            label="Rotator"
                            onChange={(event) => setCreateSelectedRotatorId(String(event.target.value))}
                            renderValue={(selected) => {
                                if (String(selected) === 'none') return 'No rotator control';
                                const selectedRotator = rotatorRows.find((row) => String(row.id) === String(selected));
                                if (!selectedRotator) return 'No rotator control';
                                const usageRows = rotatorUsageById[String(selectedRotator.id)] || [];
                                const inUseLabel = usageRows.length > 0
                                    ? `In use ${usageRows.slice(0, 2).map((row) => `T${row.targetNumber}`).join(',')}`
                                    : null;
                                return (
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                                        <Typography variant="body2" noWrap sx={{ fontWeight: 600, minWidth: 0 }}>
                                            {selectedRotator.name}
                                        </Typography>
                                        {inUseLabel && (
                                            <Chip
                                                size="small"
                                                color="warning"
                                                label={inUseLabel}
                                                sx={{ height: 18, fontSize: '0.62rem', flexShrink: 0 }}
                                            />
                                        )}
                                        <Chip
                                            size="small"
                                            label={`${selectedRotator.host}:${selectedRotator.port}`}
                                            variant="outlined"
                                            sx={{ height: 18, fontSize: '0.62rem', fontFamily: 'monospace', flexShrink: 0 }}
                                        />
                                    </Box>
                                );
                            }}
                        >
                            <MenuItem value="none">
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                        No rotator control
                                    </Typography>
                                    <Chip
                                        label="None"
                                        size="small"
                                        variant="outlined"
                                        sx={{ ml: 'auto', height: 18, fontSize: '0.62rem' }}
                                    />
                                </Box>
                            </MenuItem>
                            {rotatorRows.map((rotator) => {
                                const usageRows = rotatorUsageById[String(rotator.id)] || [];
                                const inUseLabel = usageRows.length > 0
                                    ? `In use ${usageRows.slice(0, 2).map((row) => `T${row.targetNumber}`).join(',')}`
                                    : null;
                                return (
                                <MenuItem key={rotator.id} value={String(rotator.id)} sx={{ py: 0.75 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                                        <Typography variant="body2" noWrap sx={{ fontWeight: 600, minWidth: 0, flex: 1 }}>
                                            {rotator.name || rotator.id}
                                        </Typography>
                                        {inUseLabel && (
                                            <Chip
                                                size="small"
                                                color="warning"
                                                label={inUseLabel}
                                                sx={{ height: 18, fontSize: '0.62rem', flexShrink: 0 }}
                                            />
                                        )}
                                        <Chip
                                            size="small"
                                            label={`${rotator.host}:${rotator.port}`}
                                            variant="outlined"
                                            sx={{ height: 18, fontSize: '0.62rem', flexShrink: 0, fontFamily: 'monospace' }}
                                        />
                                    </Box>
                                </MenuItem>
                            );
                            })}
                        </Select>
                    </FormControl>

                    <FormControl
                        size="small"
                        fullWidth
                        variant="outlined"
                        sx={{ minWidth: 200, mt: 0, mb: 0.5 }}
                    >
                        <InputLabel id="create-target-rig-label">Rig</InputLabel>
                        <Select
                            labelId="create-target-rig-label"
                            value={createSelectedRigId}
                            label="Rig"
                            onChange={(event) => setCreateSelectedRigId(String(event.target.value))}
                            renderValue={(selected) => {
                                if (String(selected) === 'none') return 'No rig control';
                                const selectedRig = rigRows.find((row) => String(row.id) === String(selected));
                                if (!selectedRig) return 'No rig control';
                                const usageRows = rigUsageById[String(selectedRig.id)] || [];
                                const inUseLabel = usageRows.length > 0
                                    ? `In use ${usageRows.slice(0, 2).map((row) => `T${row.targetNumber}`).join(',')}`
                                    : null;
                                return (
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                                        <Typography variant="body2" noWrap sx={{ fontWeight: 600, minWidth: 0 }}>
                                            {selectedRig.name}
                                        </Typography>
                                        {inUseLabel && (
                                            <Chip
                                                size="small"
                                                color="warning"
                                                label={inUseLabel}
                                                sx={{ height: 18, fontSize: '0.62rem', flexShrink: 0 }}
                                            />
                                        )}
                                        <Chip
                                            size="small"
                                            label={`${selectedRig.host}:${selectedRig.port}`}
                                            variant="outlined"
                                            sx={{ height: 18, fontSize: '0.62rem', fontFamily: 'monospace', flexShrink: 0 }}
                                        />
                                    </Box>
                                );
                            }}
                        >
                            <MenuItem value="none">
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                                        No rig control
                                    </Typography>
                                    <Chip
                                        label="None"
                                        size="small"
                                        variant="outlined"
                                        sx={{ ml: 'auto', height: 18, fontSize: '0.62rem' }}
                                    />
                                </Box>
                            </MenuItem>
                            {rigRows.map((rig) => {
                                const usageRows = rigUsageById[String(rig.id)] || [];
                                const inUseLabel = usageRows.length > 0
                                    ? `In use ${usageRows.slice(0, 2).map((row) => `T${row.targetNumber}`).join(',')}`
                                    : null;
                                return (
                                <MenuItem key={rig.id} value={String(rig.id)} sx={{ py: 0.75 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                                        <Typography variant="body2" noWrap sx={{ fontWeight: 600, minWidth: 0, flex: 1 }}>
                                            {rig.name || rig.id}
                                        </Typography>
                                        {inUseLabel && (
                                            <Chip
                                                size="small"
                                                color="warning"
                                                label={inUseLabel}
                                                sx={{ height: 18, fontSize: '0.62rem', flexShrink: 0 }}
                                            />
                                        )}
                                        <Chip
                                            size="small"
                                            label={`${rig.host}:${rig.port}`}
                                            variant="outlined"
                                            sx={{ height: 18, fontSize: '0.62rem', flexShrink: 0, fontFamily: 'monospace' }}
                                        />
                                    </Box>
                                </MenuItem>
                            );
                            })}
                        </Select>
                    </FormControl>
                    </Box>

                </Box>
                {createDialogError && (
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
                            {createDialogError}
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
                    disabled={createTargetBusy}
                    onClick={handleCloseCreateDialog}
                >
                    Cancel
                </Button>
                <Button
                    variant="contained"
                    color="success"
                    disabled={createTargetBusy || !createSelectedSatellite?.norad_id}
                    onClick={handleCreateTargetSubmit}
                    startIcon={createTargetBusy ? <CircularProgress color="inherit" size={16} /> : <AddCircleIcon />}
                >
                    Create Target
                </Button>
            </DialogActions>
        </Dialog>
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                pl: 0,
                pr: 1.5,
                py: 0,
                bgcolor: 'background.paper',
                borderBottom: '1px solid',
                borderColor: 'border.main',
                minHeight: '64px',
                height: '64px',
                maxHeight: '64px',
                minWidth: 0,
                overflow: 'hidden',
            }}
        >
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    flex: '1 1 auto',
                    minWidth: 0,
                    height: '100%',
                }}
            >
                <Box
                    sx={{
                        width: 'auto',
                        flex: '1 1 auto',
                        height: '100%',
                        display: 'flex',
                        alignItems: 'stretch',
                        minWidth: 0,
                    }}
                >
                    {targetOptions.length === 0 ? (
                        <Box
                            sx={{
                                px: 0.5,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.5,
                            }}
                        >
                            <IconButton
                                onClick={handleOpenCreateDialog}
                                sx={{
                                    width: 42,
                                    height: 42,
                                    color: 'text.secondary',
                                    '&:hover': {
                                        backgroundColor: 'action.hover',
                                    },
                                }}
                            >
                                <Typography component="span" sx={{ fontSize: '1.9rem', lineHeight: 1, fontWeight: 700 }}>
                                    +
                                </Typography>
                            </IconButton>
                            <Typography
                                variant="button"
                                sx={{
                                    color: 'text.secondary',
                                    fontWeight: 600,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    lineHeight: 1,
                                    ml: 0.2,
                                }}
                            >
                                add target
                            </Typography>
                        </Box>
                    ) : (
                        <Tabs
                            value={tabValue}
                            onChange={handleTargetTabChange}
                            variant="scrollable"
                            scrollButtons="auto"
                            allowScrollButtonsMobile
                            sx={{
                                width: 'auto',
                                minWidth: 0,
                                minHeight: '100%',
                                height: '100%',
                                flex: '0 1 auto',
                                '& .MuiTabs-scroller': {
                                    display: 'flex',
                                    alignItems: 'stretch',
                                },
                                '& .MuiTabs-scrollButtons': {
                                    flexShrink: 0,
                                },
                                '& .MuiTabs-scrollButtons.Mui-disabled': {
                                    width: 0,
                                    minWidth: 0,
                                    padding: 0,
                                    margin: 0,
                                },
                                '& .MuiTabs-flexContainer': {
                                    minHeight: '100%',
                                    height: '100%',
                                    alignItems: 'stretch',
                                },
                                '& .MuiTabs-indicator': { display: 'none' },
                                '& .MuiTab-root': {
                                    minHeight: '100%',
                                    height: '100%',
                                    textTransform: 'none',
                                    px: 1.5,
                                    py: 0,
                                    mr: 0.25,
                                    minWidth: 120,
                                    borderRadius: 0,
                                    border: '1px solid transparent',
                                    borderColor: 'transparent',
                                    color: 'text.secondary',
                                    fontWeight: 600,
                                    '&.Mui-selected': {
                                        color: 'primary.contrastText',
                                        backgroundColor: 'primary.main',
                                        borderColor: 'primary.dark',
                                    }
                                },
                            }}
                        >
                            {targetOptions.map((option) => {
                                const shortName = option.satName.length > 20
                                    ? `${option.satName.slice(0, 20)}...`
                                    : option.satName;
                                const trackerLabel = option.isObservationTracker
                                    ? 'OBS'
                                    : `T${option.targetNumber}`;
                                const tooltipLines = [
                                    option.isObservationTracker
                                        ? `Observation tracker (${option.trackerId})`
                                        : `Target ${option.targetNumber}`,
                                    `${option.satName}`,
                                    `NORAD ${option.satNorad}`,
                                    `Rotator ${option.rotatorName}`,
                                    `HW ${option.tabHardwareLed?.label || 'Unknown'}`,
                                ];
                                if (option.runningObsCount > 0) {
                                    tooltipLines.push(`Obs running: ${option.runningObsCount}`);
                                }
                                const TabHardwareLedIcon = option.tabHardwareLed?.Icon;
                                return (
                                    <Tab
                                        key={option.trackerId}
                                        value={option.trackerId}
                                        label={
                                            <Tooltip
                                                title={tooltipLines.join(' | ')}
                                                arrow
                                            >
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.7, maxWidth: 230 }}>
                                                    <Box
                                                        sx={{
                                                            width: 18,
                                                            height: 18,
                                                            borderRadius: '50%',
                                                            bgcolor: option.tabHardwareLed?.bgColor || 'action.disabled',
                                                            border: '1px solid',
                                                            borderColor: option.tabHardwareLed?.borderColor || 'action.disabledBackground',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            flexShrink: 0,
                                                        }}
                                                    >
                                                        {TabHardwareLedIcon ? (
                                                            <TabHardwareLedIcon
                                                                sx={{
                                                                    fontSize: '0.78rem',
                                                                    color: option.tabHardwareLed?.iconColor || 'common.white',
                                                                }}
                                                            />
                                                        ) : null}
                                                    </Box>
                                                    <Typography variant="caption" sx={{ fontWeight: 900, fontSize: '1.2rem', lineHeight: 1 }}>
                                                        {trackerLabel}
                                                    </Typography>
                                                    <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', maxWidth: 190 }}>
                                                        <Typography
                                                            variant="caption"
                                                            noWrap
                                                            sx={{ fontSize: '0.72rem', maxWidth: '100%', display: 'block', lineHeight: 1.1 }}
                                                        >
                                                            {shortName}
                                                        </Typography>
                                                        <Typography
                                                            variant="caption"
                                                            noWrap
                                                            sx={{
                                                                display: 'block',
                                                                fontSize: '0.61rem',
                                                                opacity: 0.9,
                                                                maxWidth: '100%',
                                                                fontFamily: 'monospace',
                                                                lineHeight: 1.05,
                                                            }}
                                                        >
                                                            {`Az ${option.satAz != null ? option.satAz.toFixed(1) : '--'}° • El ${option.satEl != null ? option.satEl.toFixed(1) : '--'}°`}
                                                        </Typography>
                                                    </Box>
                                                    <IconButton
                                                        size="small"
                                                        onClick={(event) => handleDeleteTarget(event, option)}
                                                        sx={{
                                                            p: 0.3,
                                                            ml: 0.2,
                                                            color: 'inherit',
                                                            '&:hover': {
                                                                bgcolor: 'rgba(255,255,255,0.16)',
                                                            },
                                                        }}
                                                    >
                                                        <CloseIcon sx={{ fontSize: '0.95rem' }} />
                                                    </IconButton>
                                                </Box>
                                            </Tooltip>
                                        }
                                        sx={{
                                            ...(option.hasActiveObservation ? {
                                                backgroundImage: 'repeating-linear-gradient(135deg, rgba(255, 193, 7, 0.22) 0px, rgba(255, 193, 7, 0.22) 7px, rgba(255, 87, 34, 0.2) 7px, rgba(255, 87, 34, 0.2) 14px)',
                                                '&.Mui-selected': {
                                                    backgroundImage: 'repeating-linear-gradient(135deg, rgba(255, 193, 7, 0.22) 0px, rgba(255, 193, 7, 0.22) 7px, rgba(255, 87, 34, 0.2) 7px, rgba(255, 87, 34, 0.2) 14px)',
                                                },
                                            } : {}),
                                        }}
                                    />
                                );
                            })}
                            <Tab
                                value={ADD_TARGET_TAB_VALUE}
                                label={
                                    <Tooltip title="Add target" arrow>
                                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20 }}>
                                            <Typography component="span" sx={{ fontSize: '2rem', lineHeight: 1, fontWeight: 700 }}>
                                                +
                                            </Typography>
                                        </Box>
                                    </Tooltip>
                                }
                                sx={{
                                    minWidth: '40px !important',
                                    maxWidth: '40px !important',
                                    width: '40px',
                                    px: '0 !important',
                                    mr: '0 !important',
                                    '&.Mui-selected': {
                                        color: 'text.secondary',
                                        backgroundColor: 'transparent',
                                        borderColor: 'transparent',
                                    },
                                }}
                            />
                        </Tabs>
                    )}
                </Box>
            </Box>
            <Box
                sx={{
                    alignItems: 'center',
                    flex: '0 0 380px',
                    minWidth: 320,
                    maxWidth: 440,
                    display: { xs: 'none', lg: 'flex' },
                    gap: 1,
                }}
            >
                <SatelliteSearchAutocomplete
                    key={searchResetKey}
                    onSatelliteSelect={handleRetargetSatelliteSelect}
                    disabled={disableRetargetSearch}
                />
            </Box>
        </Box>
        </>
    );
});

export default TargetSatelliteSelectorBar;
