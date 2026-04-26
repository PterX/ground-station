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


import {useEffect, useState} from "react";
import {FormControl, InputLabel, MenuItem, Select} from "@mui/material";
import * as React from "react";
import {useDispatch, useSelector} from "react-redux";
import { useTranslation } from 'react-i18next';
import {
    setSatelliteGroupSelectOpen,
    setSatelliteSelectOpen,
    setSatelliteId,
    setRadioRig,
    setTrackerId,
    setRotator,
    setTrackingStateInBackend,
    setAvailableTransmitters,
} from './target-slice.jsx';
import {useSocket} from "../common/socket.jsx";
import { useTargetRotatorSelectionDialog } from './use-target-rotator-selection-dialog.jsx';
import { toast } from "../../utils/toast-with-timestamp.jsx";


function SatelliteList() {
    const dispatch = useDispatch();
    const {socket} = useSocket();
    const { t } = useTranslation('target');
    const {
        satelliteData,
        groupOfSats,
        satelliteId,
        groupId,
        loading,
        satelliteSelectOpen,
        satelliteGroupSelectOpen,
        trackingState,
        uiTrackerDisabled,
        starting,
        selectedRadioRig,
        selectedRotator,
        selectedTransmitter,
        availableTransmitters,
    } = useSelector((state) => state.targetSatTrack);
    const { requestRotatorForTarget, dialog: rotatorSelectionDialog } = useTargetRotatorSelectionDialog();

    const getTargetLimitMessage = (error) => {
        const limit = Number(error?.data?.limit);
        if (Number.isFinite(limit) && limit > 0) {
            return `Target limit reached (${limit}). Delete an existing target first.`;
        }
        return 'Target limit reached. Delete an existing target first.';
    };

    function getTransmittersForSatelliteId(satelliteId) {
        if (satelliteId && groupOfSats.length > 0) {
            const satellite = groupOfSats.find(s => s.norad_id === satelliteId);
            if (satellite) {
                return satellite.transmitters || [];
            } else {
                return [];
            }
        }
        return [];
    }

    async function setTargetSatellite(eventOrSatelliteId) {
        // Determine the satelliteId based on the input type
        const satelliteId = typeof eventOrSatelliteId === 'object'
            ? eventOrSatelliteId.target.value
            : eventOrSatelliteId;
        const selectedSatellite = groupOfSats.find((sat) => String(sat.norad_id) === String(satelliteId));
        await requestRotatorForTarget(selectedSatellite?.name, {
            onSubmit: async (selectedAssignment) => {
                if (!selectedAssignment) {
                    return { success: false };
                }
                const assignmentAction = String(selectedAssignment?.action || 'retarget_current_slot');
                const isCreateNewSlot = assignmentAction === 'create_new_slot';
                const trackerId = String(selectedAssignment?.trackerId || '');
                const rotatorId = String(selectedAssignment?.rotatorId || 'none');
                const assignmentRigId = String(selectedAssignment?.rigId || 'none');
                if (!trackerId) {
                    return { success: false, errorMessage: 'Missing target tracker slot.' };
                }
                const selectedGroupId = selectedSatellite?.groups?.[0]?.id || groupId || trackingState?.group_id || '';
                const nextRigId = isCreateNewSlot ? assignmentRigId : selectedRadioRig;
                const nextRotatorId = isCreateNewSlot ? 'none' : rotatorId;
                const nextTransmitterId = isCreateNewSlot ? 'none' : selectedTransmitter;

                // Set the tracking state in the backend to the new norad id and leave the state as is.
                const data = isCreateNewSlot
                    ? {
                        tracker_id: trackerId,
                        norad_id: satelliteId,
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
                        tracker_id: trackerId,
                        norad_id: satelliteId,
                        group_id: selectedGroupId,
                        rig_id: nextRigId,
                        rotator_id: nextRotatorId,
                        transmitter_id: nextTransmitterId,
                    };
                try {
                    await dispatch(setTrackingStateInBackend({ socket, data })).unwrap();
                    dispatch(setTrackerId(trackerId));
                    dispatch(setSatelliteId(satelliteId));
                    dispatch(setRotator({ value: nextRotatorId, trackerId }));
                    dispatch(setRadioRig({ value: nextRigId, trackerId }));
                    dispatch(setAvailableTransmitters(getTransmittersForSatelliteId(satelliteId)));
                    return { success: true };
                } catch (error) {
                    const errorCode = String(error?.error || error?.code || '').trim();
                    if (errorCode === 'tracker_slot_limit_reached') {
                        return { success: false, errorMessage: getTargetLimitMessage(error) };
                    }
                    toast.error(error?.message || 'Failed to set target');
                    return { success: false, errorMessage: error?.message || 'Failed to set target' };
                }
            },
        });
    }

    const handleSelectOpenEvent = (event) => {
        dispatch(setSatelliteSelectOpen(true));
    };

    const handleSelectCloseEvent = (event) => {
        dispatch(setSatelliteSelectOpen(false));
    };

    return (
        <>
        {rotatorSelectionDialog}
        <FormControl
            disabled={trackingState['rotator_state'] === "tracking" || trackingState['rig_state'] === "tracking"}
            sx={{ margin: 0 }}
            fullWidth={true}
            size="small">
            <InputLabel htmlFor="satellite-select">{t('satellite_dropdown.label')}</InputLabel>
            <Select onClose={handleSelectCloseEvent}
                    onOpen={handleSelectOpenEvent}
                    value={groupOfSats.length > 0 && groupOfSats.find(s => s.norad_id === satelliteId) ? satelliteId : ""}
                    id="satellite-select" label={t('satellite_dropdown.label')}
                    size="small"
                    onChange={setTargetSatellite}>
                {groupOfSats.map((satellite, index) => {
                    return <MenuItem value={satellite['norad_id']}
                                     key={index}>#{satellite['norad_id']} {satellite['name']}</MenuItem>;
                })}
            </Select>
        </FormControl>
        </>
    );
}

export default SatelliteList;
