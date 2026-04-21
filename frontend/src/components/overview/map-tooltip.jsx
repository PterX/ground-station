
import React, { useState, useEffect, useRef } from 'react';
import { Marker } from 'react-leaflet';
import { Button, Box, IconButton } from '@mui/material';
import { ThemedLeafletTooltip } from "../common/common.jsx";
import { styled } from '@mui/material/styles';
import { Tooltip as LeafletTooltip } from 'react-leaflet';
import TrackChangesIcon from '@mui/icons-material/TrackChanges';
import InfoIcon from '@mui/icons-material/Info';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import TargetNumberIcon from '../common/target-number-icon.jsx';

// Styled tooltip specifically for tracked satellites
const TrackedSatelliteTooltip = styled(LeafletTooltip)(({ theme }) => ({
    color: theme.palette.text.primary,
    backgroundColor: theme.palette.error.dark,
    borderRadius: theme.shape.borderRadius,
    borderColor: theme.palette.error.main,
    zIndex: 1000,
    '&::before': {
        borderBottomColor: `${theme.palette.error.main} !important`,
    },
}));

const SatelliteMarker = ({
                             satellite,
                             position,
                             altitude,
                             velocity,
                             isVisible = false,
                             trackingSatelliteId,
                             trackingSatelliteIds = [],
                             targetNumberByNorad = {},
                             selectedSatelliteId,
                             markerEventHandlers,
                             satelliteIcon,
                             opacity = 1,
                             handleSetTrackingOnBackend,
                         }) => {
    const navigate = useNavigate();
    const { t } = useTranslation('overview');

    const normalizedTrackingIds = Array.isArray(trackingSatelliteIds)
        ? trackingSatelliteIds.map((id) => String(id))
        : (trackingSatelliteId != null ? [String(trackingSatelliteId)] : []);
    const isTracking = normalizedTrackingIds.includes(String(satellite.norad_id));
    const targetNumber = targetNumberByNorad?.[String(satellite.norad_id)] ?? null;

    // Local state for the disabled property
    const [isDisabled, setIsDisabled] = useState(isTracking);

    // Update local state whenever the dependencies change
    useEffect(() => {
        setIsDisabled(isTracking);
    }, [isTracking]);

    const isSelected = selectedSatelliteId === satellite.norad_id;

    // Choose which tooltip component to use
    const TooltipComponent = isTracking ? TrackedSatelliteTooltip : ThemedLeafletTooltip;

    const handleSetTarget = (e) => {
        e.stopPropagation();
        if (handleSetTrackingOnBackend) {
            handleSetTrackingOnBackend({
                noradId: satellite.norad_id,
                satelliteName: satellite.name,
            });
        }
    };

    const handleNavigateToSatellite = (e) => {
        e.stopPropagation();
        navigate(`/satellite/${satellite.norad_id}`);
    };

    return (
        <Marker
            key={`marker-${satellite.norad_id}-${isTracking ? 'tracked' : 'idle'}`}
            position={position}
            icon={satelliteIcon}
            eventHandlers={markerEventHandlers}
            opacity={opacity}
        >
            <TooltipComponent
                direction="bottom"
                offset={[0, isTracking ? 15 : (isVisible ? 10 : 5)]}
                permanent={true}
                className={"tooltip-satellite"}
                interactive={true}
            >
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    <strong>
                        {isTracking && (
                            <TargetNumberIcon
                                targetNumber={targetNumber}
                                size={15}
                                sx={{ mr: 0.7, verticalAlign: 'middle', position: 'relative', top: -1 }}
                                iconColor="common.white"
                                badgeBgColor="warning.main"
                                badgeTextColor="common.black"
                            />
                        )}
                        {satellite.name} - {parseInt(altitude) + " km, " + velocity.toFixed(2) + " km/s"}
                    </strong>
                    {isSelected && !isTracking && (
                        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                            <Button
                                size="small"
                                variant="contained"
                                color="primary"
                                startIcon={<TrackChangesIcon />}
                                onClick={handleSetTarget}
                                sx={{
                                    fontSize: '0.7rem',
                                    py: 0.3,
                                    px: 1,
                                    flex: 1,
                                }}
                            >
                                {t('map_target.set_target')}
                            </Button>
                            <IconButton
                                onClick={handleNavigateToSatellite}
                                sx={{
                                    backgroundColor: 'action.hover',
                                    '&:hover': {
                                        backgroundColor: 'action.selected',
                                    },
                                    padding: '4px',
                                }}
                                size="small"
                                title={t('map_target.view_details')}
                            >
                                <InfoIcon fontSize="small" />
                            </IconButton>
                        </Box>
                    )}
                </Box>
            </TooltipComponent>
        </Marker>
    );
};

export default React.memo(SatelliteMarker);
