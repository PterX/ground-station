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
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import TrendingDownIcon from '@mui/icons-material/TrendingDown';
import HorizontalRuleIcon from '@mui/icons-material/HorizontalRule';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import GpsOffIcon from '@mui/icons-material/GpsOff';
import StopIcon from '@mui/icons-material/Stop';
import CloseIcon from '@mui/icons-material/Close';
import AddCircleIcon from '@mui/icons-material/AddCircle';
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

const TARGET_SLOT_ID_PATTERN = /^target-(\d+)$/;
const ADD_TARGET_TAB_VALUE = '__add-target__';

const deriveNextTrackerSlotId = (instances = []) => {
    let maxTargetNumber = 0;
    instances.forEach((instance) => {
        const trackerId = String(instance?.tracker_id || '');
        const match = trackerId.match(TARGET_SLOT_ID_PATTERN);
        if (!match) return;
        const targetNumber = Number(match[1]);
        if (Number.isFinite(targetNumber) && targetNumber > maxTargetNumber) {
            maxTargetNumber = targetNumber;
        }
    });
    return `target-${Math.max(1, maxTargetNumber + 1)}`;
};

const TargetSatelliteSelectorBar = React.memo(function TargetSatelliteSelectorBar() {
    const { socket } = useSocket();
    const dispatch = useDispatch();
    const { t } = useTranslation('target');

    const {
        trackingState,
        trackerId,
        satellitePasses,
        satelliteId,
        satelliteData,
        selectedRadioRig,
        selectedTransmitter,
        rigData,
        rotatorData,
    } = useSelector((state) => state.targetSatTrack);
    const trackerInstances = useSelector((state) => state.trackerInstances?.instances || []);
    const rigRows = useSelector((state) => state.rigs?.rigs || []);
    const rotatorRows = useSelector((state) => state.rotators?.rotators || []);
    const activeTrackerInstance = useMemo(
        () => trackerInstances.find((instance) => instance.tracker_id === trackerId) || null,
        [trackerInstances, trackerId]
    );
    const activeTargetNumber = activeTrackerInstance?.target_number
        || (trackerInstances.findIndex((instance) => instance.tracker_id === trackerId) + 1)
        || null;

    const selectedSatellitePositions = useSelector(state => state.overviewSatTrack.selectedSatellitePositions);
    const trackerViews = useSelector((state) => state.targetSatTrack?.trackerViews || {});
    const { requestRotatorForTarget, dialog: rotatorSelectionDialog } = useTargetRotatorSelectionDialog();
    const [countdown, setCountdown] = useState('');
    const [searchResetKey, setSearchResetKey] = useState(0);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [pendingDeleteTarget, setPendingDeleteTarget] = useState(null);
    const [deleteTargetBusy, setDeleteTargetBusy] = useState(false);
    const [createDialogOpen, setCreateDialogOpen] = useState(false);
    const [createTargetBusy, setCreateTargetBusy] = useState(false);
    const [createSearchOpen, setCreateSearchOpen] = useState(false);
    const [createSearchOptions, setCreateSearchOptions] = useState([]);
    const [createSearchLoading, setCreateSearchLoading] = useState(false);
    const [createSelectedSatellite, setCreateSelectedSatellite] = useState(null);
    const [createSelectedRigId, setCreateSelectedRigId] = useState('none');
    const [createSelectedRotatorId, setCreateSelectedRotatorId] = useState('none');

    const handleTrackingStop = useCallback(() => {
        if (!trackerId) {
            return;
        }
        const newTrackingState = {
            ...trackingState,
            tracker_id: trackerId,
            'rotator_state': "stopped",
            'rig_state': "stopped",
        };
        dispatch(setTrackingStateInBackend({socket, data: newTrackingState}));
    }, [dispatch, socket, trackingState, trackerId]);

    const handleTargetTabChange = useCallback((event, value) => {
        if (!value) return;
        if (value === ADD_TARGET_TAB_VALUE) {
            setCreateDialogOpen(true);
            return;
        }
        dispatch(setTrackerId(value));
    }, [dispatch]);

    const handleDeleteTarget = useCallback((event, trackerIdToDelete) => {
        event.preventDefault();
        event.stopPropagation();
        if (!trackerIdToDelete) {
            return;
        }
        const instance = trackerInstances.find((row) => row?.tracker_id === trackerIdToDelete);
        const targetNumber = Number(
            instance?.target_number
            || (trackerInstances.findIndex((row) => row?.tracker_id === trackerIdToDelete) + 1)
            || 0
        );
        setPendingDeleteTarget({ trackerId: trackerIdToDelete, targetNumber });
        setDeleteDialogOpen(true);
    }, [trackerInstances]);

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
        if (!createSelectedSatellite?.norad_id) {
            toast.error('Please select a satellite first');
            return;
        }

        const selectedGroupId = createSelectedSatellite?.groups?.[0]?.id || trackingState?.group_id || '';
        if (!selectedGroupId) {
            toast.error('Selected satellite has no group mapping');
            return;
        }

        const trackerSlotId = deriveNextTrackerSlotId(trackerInstances);
        const normalizedRigId = createSelectedRigId || 'none';
        const normalizedRotatorId = createSelectedRotatorId || 'none';
        const nextTransmitters = getTransmittersFromSatellite(createSelectedSatellite);

        const payload = {
            ...trackingState,
            tracker_id: trackerSlotId,
            norad_id: createSelectedSatellite.norad_id,
            group_id: selectedGroupId,
            rig_id: normalizedRigId,
            rotator_id: normalizedRotatorId,
            transmitter_id: 'none',
            rig_state: trackingState?.rig_state || 'disconnected',
            rotator_state: trackingState?.rotator_state || 'disconnected',
            rig_vfo: trackingState?.rig_vfo || 'none',
            vfo1: trackingState?.vfo1 || 'uplink',
            vfo2: trackingState?.vfo2 || 'downlink',
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
            toast.error(error?.message || 'Failed to create target');
            setCreateTargetBusy(false);
        }
    }, [
        createSelectedRigId,
        createSelectedRotatorId,
        createSelectedSatellite,
        dispatch,
        getTransmittersFromSatellite,
        resetCreateDialogState,
        socket,
        trackerInstances,
        trackingState,
    ]);

    const handleRetargetSatelliteSelect = useCallback(async (satellite) => {
        if (!satellite?.norad_id) {
            return;
        }

        const selectedAssignment = await requestRotatorForTarget(satellite?.name);
        if (!selectedAssignment) {
            return;
        }

        const { rotatorId, trackerId: selectedTrackerId } = selectedAssignment;
        const selectedGroupId = satellite?.groups?.[0]?.id || trackingState?.group_id || "";
        const nextTransmitters = getTransmittersFromSatellite(satellite);

        dispatch(setSatelliteId(satellite.norad_id));
        dispatch(setRotator(rotatorId));
        dispatch(setTrackerId(selectedTrackerId));
        dispatch(setAvailableTransmitters(nextTransmitters));

        const data = {
            ...trackingState,
            tracker_id: selectedTrackerId,
            norad_id: satellite.norad_id,
            group_id: selectedGroupId,
            rig_id: selectedRadioRig,
            rotator_id: rotatorId,
            transmitter_id: selectedTransmitter,
        };

        try {
            await dispatch(setTrackingStateInBackend({ socket, data })).unwrap();
            setSearchResetKey((value) => value + 1);
        } catch (error) {
            toast.error(error?.message || 'Failed to set target');
        }
    }, [
        dispatch,
        getTransmittersFromSatellite,
        requestRotatorForTarget,
        selectedRadioRig,
        selectedTransmitter,
        socket,
        trackingState,
    ]);

    // Get current active pass or next upcoming pass
    const passInfo = useMemo(() => {
        if (!satellitePasses || satellitePasses.length === 0 || !satelliteId) return null;

        const now = new Date();

        // Find active pass
        const activePass = satellitePasses.find(pass => {
            if (pass.norad_id !== satelliteId) return false;
            const start = new Date(pass.event_start);
            const end = new Date(pass.event_end);
            return now >= start && now <= end;
        });

        if (activePass) {
            return { type: 'active', pass: activePass };
        }

        // Find next upcoming pass
        let nextPass = null;
        let earliestTime = null;

        for (const pass of satellitePasses) {
            if (pass.norad_id === satelliteId) {
                const startTime = new Date(pass.event_start);
                if (startTime > now) {
                    if (!nextPass || startTime < earliestTime) {
                        nextPass = pass;
                        earliestTime = startTime;
                    }
                }
            }
        }

        if (nextPass) {
            return { type: 'upcoming', pass: nextPass };
        }

        return null;
    }, [satellitePasses, satelliteId]);

    // Update countdown every second
    useEffect(() => {
        if (!passInfo) {
            setCountdown('');
            return;
        }

        const updateCountdown = () => {
            const now = new Date();
            const targetTime = passInfo.type === 'active'
                ? new Date(passInfo.pass.event_end)
                : new Date(passInfo.pass.event_start);

            const diff = targetTime - now;

            if (diff <= 0) {
                setCountdown('0s');
                return;
            }

            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);

            if (days > 0) {
                setCountdown(`${days}d ${hours}h ${minutes}m`);
            } else if (hours > 0) {
                setCountdown(`${hours}h ${minutes}m ${seconds}s`);
            } else if (minutes > 0) {
                setCountdown(`${minutes}m ${seconds}s`);
            } else {
                setCountdown(`${seconds}s`);
            }
        };

        updateCountdown();
        const interval = setInterval(updateCountdown, 1000);

        return () => clearInterval(interval);
    }, [passInfo]);

    const targetOptions = useMemo(() => trackerInstances.map((instance, index) => {
        const instanceTrackerId = instance?.tracker_id || '';
        const targetNumber = Number(instance?.target_number || (index + 1));
        const view = trackerViews?.[instanceTrackerId] || {};
        const satName = view?.satelliteData?.details?.name || 'No satellite';
        const satNorad = view?.trackingState?.norad_id || 'none';
        const rotatorId = view?.selectedRotator || instance?.rotator_id || 'none';
        const isTracking = Boolean(view?.rigData?.tracking || view?.rotatorData?.tracking);
        const satAz = Number.isFinite(view?.satelliteData?.position?.az) ? view.satelliteData.position.az : null;
        const satEl = Number.isFinite(view?.satelliteData?.position?.el) ? view.satelliteData.position.el : null;
        return {
            trackerId: instanceTrackerId,
            targetNumber,
            satName,
            satNorad,
            rotatorId,
            isTracking,
            satAz,
            satEl,
        };
    }), [trackerInstances, trackerViews]);

    const tabValue = targetOptions.some((option) => option.trackerId === trackerId)
        ? trackerId
        : (targetOptions[0]?.trackerId || false);
    const nextTargetSlotId = useMemo(() => deriveNextTrackerSlotId(trackerInstances), [trackerInstances]);
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
                                <Typography component="span" sx={{ fontSize: '1.6rem', lineHeight: 1, fontWeight: 700 }}>
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
                                return (
                                    <Tab
                                        key={option.trackerId}
                                        value={option.trackerId}
                                        label={
                                            <Tooltip
                                                title={`Target ${option.targetNumber} | ${option.satName} | NORAD ${option.satNorad} | Rotator ${option.rotatorId}`}
                                                arrow
                                            >
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.7, maxWidth: 230 }}>
                                                    <Box
                                                        sx={{
                                                            width: 16,
                                                            height: 16,
                                                            borderRadius: '50%',
                                                            bgcolor: option.isTracking ? 'success.light' : 'action.disabled',
                                                            flexShrink: 0,
                                                        }}
                                                    />
                                                    <Typography variant="caption" sx={{ fontWeight: 900, fontSize: '1.2rem', lineHeight: 1 }}>
                                                        T{option.targetNumber}
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
                                                        onClick={(event) => handleDeleteTarget(event, option.trackerId)}
                                                        sx={{
                                                            p: 0.2,
                                                            ml: 0.2,
                                                            color: 'inherit',
                                                            '&:hover': {
                                                                bgcolor: 'rgba(255,255,255,0.16)',
                                                            },
                                                        }}
                                                    >
                                                        <CloseIcon sx={{ fontSize: '0.78rem' }} />
                                                    </IconButton>
                                                </Box>
                                            </Tooltip>
                                        }
                                    />
                                );
                            })}
                            <Tab
                                value={ADD_TARGET_TAB_VALUE}
                                label={
                                    <Tooltip title="Add target" arrow>
                                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18 }}>
                                            <Typography component="span" sx={{ fontSize: '1.75rem', lineHeight: 1, fontWeight: 700 }}>
                                                +
                                            </Typography>
                                        </Box>
                                    </Tooltip>
                                }
                                sx={{
                                    minWidth: '36px !important',
                                    maxWidth: '36px !important',
                                    width: '36px',
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
                    flex: '0 0 320px',
                    minWidth: 280,
                    maxWidth: 360,
                    display: { xs: 'none', lg: 'flex' },
                    gap: 1,
                }}
            >
                <SatelliteSearchAutocomplete
                    key={searchResetKey}
                    onSatelliteSelect={handleRetargetSatelliteSelect}
                />
            </Box>

            {/* Pills + Stop (desktop row) OR Stop only (mobile/tablet column) */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    ml: 'auto',
                    flexShrink: 0,
                    minWidth: 0,
                }}
            >
                {/* Tracking status badge */}
                {satelliteId && (
                    <Tooltip title={rigData?.tracking || rotatorData?.tracking ? "Tracking active" : "Tracking stopped"}>
                        <Chip
                            icon={rigData?.tracking || rotatorData?.tracking ? <GpsFixedIcon /> : <GpsOffIcon />}
                            label={rigData?.tracking || rotatorData?.tracking ? "Tracking" : "Stopped"}
                            size="small"
                            sx={{
                                display: { xs: 'none', lg: 'flex' },
                                bgcolor: rigData?.tracking || rotatorData?.tracking ? 'success.main' : 'action.hover',
                                color: rigData?.tracking || rotatorData?.tracking ? 'white' : 'text.secondary',
                                fontWeight: 'bold',
                                '& .MuiChip-icon': {
                                    color: rigData?.tracking || rotatorData?.tracking ? 'white' : 'text.secondary',
                                }
                            }}
                        />
                    </Tooltip>
                )}

                <Tooltip
                    title={
                        activeTrackerInstance
                            ? `Target ${activeTargetNumber || '?'} | tracker ${activeTrackerInstance.tracker_id} | rotator ${activeTrackerInstance.rotator_id || 'none'}`
                            : `Tracker ${trackerId || 'none'}`
                    }
                >
                    <Chip
                        size="small"
                        color="info"
                        variant="outlined"
                        label={activeTrackerInstance ? `Target ${activeTargetNumber || '?'}` : 'No target'}
                        sx={{ display: { xs: 'none', xl: 'flex' } }}
                    />
                </Tooltip>

                {/* Current elevation with trend */}
                {satelliteId && satelliteData?.position && (
                    <Tooltip title={`Elevation: ${satelliteData.position.el?.toFixed(2)}°`}>
                        <Chip
                            icon={
                                selectedSatellitePositions?.[satelliteId]?.trend === 'rising_slow' || selectedSatellitePositions?.[satelliteId]?.trend === 'rising_fast' ? <TrendingUpIcon /> :
                                selectedSatellitePositions?.[satelliteId]?.trend === 'falling_slow' || selectedSatellitePositions?.[satelliteId]?.trend === 'falling_fast' ? <TrendingDownIcon /> :
                                selectedSatellitePositions?.[satelliteId]?.trend === 'peak' ? <HorizontalRuleIcon /> :
                                null
                            }
                            label={`El: ${satelliteData.position.el?.toFixed(1)}°`}
                            size="small"
                            sx={{
                                display: { xs: 'none', lg: 'flex' },
                                bgcolor: satelliteData.position.el < 0 ? 'action.hover' :
                                         satelliteData.position.el < 10 ? 'error.main' :
                                         satelliteData.position.el < 45 ? 'warning.main' : 'success.main',
                                color: satelliteData.position.el < 0 ? 'text.secondary' : 'white',
                                fontWeight: 'bold',
                                fontFamily: 'monospace',
                                '& .MuiChip-icon': {
                                    color: satelliteData.position.el < 0 ? 'text.secondary' :
                                           selectedSatellitePositions?.[satelliteId]?.trend === 'rising_slow' || selectedSatellitePositions?.[satelliteId]?.trend === 'rising_fast' ? 'info.light' :
                                           selectedSatellitePositions?.[satelliteId]?.trend === 'falling_slow' || selectedSatellitePositions?.[satelliteId]?.trend === 'falling_fast' ? 'error.light' :
                                           selectedSatellitePositions?.[satelliteId]?.trend === 'peak' ? 'warning.light' :
                                           'white',
                                }
                            }}
                        />
                    </Tooltip>
                )}

                {/* Pass countdown */}
                {passInfo && countdown && (
                    <Tooltip title={passInfo.type === 'active' ? 'Current pass ending' : 'Next pass starting'}>
                        <Chip
                            icon={passInfo.type === 'active' ? <AccessTimeIcon /> : <TrendingUpIcon />}
                            label={countdown}
                            size="small"
                            sx={{
                                display: { xs: 'none', lg: 'flex' },
                                bgcolor: passInfo.type === 'active' ? 'success.main' : 'info.main',
                                color: 'white',
                                fontWeight: 'bold',
                                fontFamily: 'monospace',
                                '& .MuiChip-icon': {
                                    color: 'white',
                                }
                            }}
                        />
                    </Tooltip>
                )}

                {/* Stop tracking button */}
                {satelliteId && (
                    <Button
                        variant="contained"
                        color="error"
                        startIcon={<StopIcon />}
                        disabled={rigData?.tracking !== true && rotatorData?.tracking !== true}
                        onClick={handleTrackingStop}
                        size="small"
                        sx={{
                            textTransform: 'none',
                            fontWeight: 'bold',
                            minWidth: { xs: 36, lg: 'auto' },
                            width: { xs: 36, lg: 'auto' },
                            px: { xs: 0, lg: 2 },
                            height: 36,
                            '& .MuiButton-startIcon': {
                                mr: { xs: 0, lg: 1 },
                                ml: 0,
                            },
                        }}
                    >
                        <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' } }}>
                            {t('satellite_selector.stop_tracking')}
                        </Box>
                    </Button>
                )}
            </Box>
        </Box>
        </>
    );
});

export default TargetSatelliteSelectorBar;
