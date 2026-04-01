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

import React, { useEffect } from 'react';
import {
    Alert,
    AlertTitle,
    Box,
    Button,
    Chip,
    Divider,
    Paper,
    Skeleton,
    Stack,
    Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { useTranslation } from 'react-i18next';
import { Circle, MapContainer, Marker, Polyline, Popup, TileLayer, useMapEvents } from 'react-leaflet';
import { useDispatch, useSelector } from 'react-redux';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { toast } from '../../utils/toast-with-timestamp.jsx';
import { getMaidenhead } from '../common/common.jsx';
import { useSocket } from '../common/socket.jsx';
import { getTileLayerById } from '../common/tile-layers.jsx';
import {
    setAltitude,
    setLocation,
    setLocationLoading,
    setPolylines,
    setQth,
    storeLocation,
} from './location-slice.jsx';

const createCustomIcon = () => {
    const svgIcon = `
        <svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="dropshadow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
                    <feOffset dx="3" dy="5" result="offset"/>
                    <feFlood flood-color="#000000" flood-opacity="0.6"/>
                    <feComposite in2="offset" operator="in"/>
                    <feMerge>
                        <feMergeNode/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
            </defs>
            <path d="M12.5 0C5.597 0 0 5.597 0 12.5c0 12.5 12.5 28.5 12.5 28.5s12.5-16 12.5-28.5C25 5.597 19.403 0 12.5 0z"
                  fill="#3388ff"
                  filter="url(#dropshadow)"/>
            <circle cx="12.5" cy="12.5" r="5" fill="white"/>
        </svg>
    `;

    return L.icon({
        iconUrl: `data:image/svg+xml;base64,${btoa(svgIcon)}`,
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowUrl: null,
        shadowSize: null,
        shadowAnchor: null,
    });
};

const setupMarkerIcons = () => {
    try {
        delete L.Icon.Default.prototype._getIconUrl;
        L.Icon.Default.mergeOptions({
            iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
            iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        });
    } catch (error) {
        console.warn('Failed to set up default marker icons:', error);
    }
};

setupMarkerIcons();
const customIcon = createCustomIcon();

function MapClickHandler({ onClick }) {
    useMapEvents({ click: onClick });
    return null;
}

const LocationPage = () => {
    const { socket } = useSocket();
    const dispatch = useDispatch();
    const { t } = useTranslation('settings');

    const [nearestCity, setNearestCity] = React.useState(null);
    const [cityLoading, setCityLoading] = React.useState(false);
    const [elevationLoading, setElevationLoading] = React.useState(false);
    const [savedState, setSavedState] = React.useState(null);
    const mapRef = React.useRef(null);

    const {
        locationLoading,
        locationSaving,
        location,
        locationId,
        qth,
        polylines,
        altitude,
    } = useSelector((state) => state.location);

    const hasLocation = location && location.lat != null && location.lon != null;
    const normalizedLocation = React.useMemo(() => {
        if (!hasLocation) return null;
        return { lat: Number(location.lat), lon: Number(location.lon) };
    }, [hasLocation, location?.lat, location?.lon]);

    const getNearestCity = async (lat, lon) => {
        try {
            const response = await fetch(
                `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
            );
            const data = await response.json();
            return data.city || data.locality || data.principalSubdivision || 'Unknown';
        } catch (error) {
            console.error('Error fetching city:', error);
            return null;
        }
    };

    const getElevation = async (lat, lon) => {
        const response = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lon}`);
        const data = await response.json();
        return data.results[0].elevation;
    };

    const reCenterMap = (lat, lon) => {
        if (mapRef.current) {
            mapRef.current.setView([lat, lon], mapRef.current.getZoom());
        }
    };

    const handleWhenReady = (map) => {
        mapRef.current = map.target;
    };

    useEffect(() => {
        if (!hasLocation) {
            setNearestCity(null);
            setCityLoading(false);
            return;
        }

        setCityLoading(true);
        getNearestCity(normalizedLocation.lat, normalizedLocation.lon)
            .then((city) => setNearestCity(city))
            .finally(() => setCityLoading(false));
    }, [hasLocation, normalizedLocation]);

    useEffect(() => {
        if (!hasLocation) {
            dispatch(setPolylines([]));
            return;
        }

        const horizontalLine = [[normalizedLocation.lat, -270], [normalizedLocation.lat, 270]];
        const verticalLine = [[-90, normalizedLocation.lon], [90, normalizedLocation.lon]];
        dispatch(setPolylines([horizontalLine, verticalLine]));
        dispatch(setQth(getMaidenhead(normalizedLocation.lat, normalizedLocation.lon)));
    }, [dispatch, hasLocation, normalizedLocation]);

    useEffect(() => {
        if (mapRef.current && hasLocation) {
            mapRef.current.invalidateSize();
            reCenterMap(normalizedLocation.lat, normalizedLocation.lon);
        }
    }, [hasLocation, normalizedLocation]);

    useEffect(() => {
        if (!savedState && hasLocation) {
            setSavedState({
                lat: Number(location.lat),
                lon: Number(location.lon),
                altitude: Number(altitude || 0),
                locationId: locationId || null,
            });
        }
    }, [savedState, hasLocation, location, altitude, locationId]);

    const isDifferentFromSaved = React.useMemo(() => {
        if (!hasLocation) return false;
        if (!savedState) return true;

        const latChanged = Math.abs(Number(location.lat) - savedState.lat) > 1e-7;
        const lonChanged = Math.abs(Number(location.lon) - savedState.lon) > 1e-7;
        const altitudeChanged = Number(altitude || 0) !== Number(savedState.altitude || 0);
        const locationIdChanged = (locationId || null) !== (savedState.locationId || null);

        return latChanged || lonChanged || altitudeChanged || locationIdChanged;
    }, [hasLocation, savedState, location, altitude, locationId]);

    const canSave = hasLocation && !locationSaving;

    const statusChip = (() => {
        if (!hasLocation) {
            return (
                <Chip
                    size="small"
                    color="warning"
                    label={t('location.state_no_location', { defaultValue: 'No location selected' })}
                />
            );
        }
        if (locationSaving) {
            return (
                <Chip
                    size="small"
                    color="info"
                    label={t('location.state_saving', { defaultValue: 'Saving...' })}
                />
            );
        }
        if (isDifferentFromSaved) {
            return (
                <Chip
                    size="small"
                    color="warning"
                    label={t('location.state_unsaved', { defaultValue: 'Unsaved changes' })}
                />
            );
        }
        return (
            <Chip
                size="small"
                color="success"
                label={t('location.state_saved', { defaultValue: 'Saved' })}
            />
        );
    })();

    const nearestCityText = cityLoading
        ? t('location.state_resolving', { defaultValue: 'Resolving...' })
        : (nearestCity || t('location.state_unavailable', { defaultValue: 'Unavailable' }));

    const elevationText = elevationLoading
        ? t('location.state_resolving', { defaultValue: 'Resolving...' })
        : (hasLocation
            ? t('location.altitude_asl', { altitude })
            : t('location.state_unavailable', { defaultValue: 'Unavailable' }));

    const timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone || t('location.state_unavailable', { defaultValue: 'Unavailable' });
    const tzOffsetHours = -new Date().getTimezoneOffset() / 60;
    const tzSign = tzOffsetHours >= 0 ? '+' : '-';
    const tzOffsetDisplay = `UTC${tzSign}${Math.abs(tzOffsetHours)}`;

    const mapCenter = hasLocation ? [normalizedLocation.lat, normalizedLocation.lon] : [20, 0];
    const mapZoom = hasLocation ? 5 : 2;

    const handleMapClick = async (e) => {
        const { lat, lng } = e.latlng;
        dispatch(setLocation({ lat, lon: lng }));
        dispatch(setQth(getMaidenhead(lat, lng)));
        reCenterMap(lat, lng);

        setCityLoading(true);
        const city = await getNearestCity(lat, lng);
        setNearestCity(city);
        setCityLoading(false);
    };

    const getCurrentLocation = async () => {
        dispatch(setLocationLoading(true));

        if (!navigator.geolocation) {
            toast.warning(t('location.geolocation_not_supported'));
            dispatch(setLocationLoading(false));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude, altitude: geoAltitude } = position.coords;

                dispatch(setLocation({ lat: latitude, lon: longitude }));

                if (geoAltitude != null) {
                    dispatch(setAltitude(geoAltitude));
                } else {
                    setElevationLoading(true);
                    getElevation(latitude, longitude)
                        .then((elevation) => {
                            dispatch(setAltitude(elevation));
                        })
                        .catch((error) => {
                            console.error('Error fetching elevation:', error);
                            toast.warning(t('location.state_elevation_unavailable', { defaultValue: 'Could not resolve elevation from external service.' }));
                        })
                        .finally(() => {
                            setElevationLoading(false);
                        });
                }

                dispatch(setQth(getMaidenhead(latitude, longitude)));
                reCenterMap(latitude, longitude);
                dispatch(setLocationLoading(false));
                toast.success(t('location.location_retrieved'));
            },
            () => {
                toast.error(t('location.failed_get_location'));
                dispatch(setLocationLoading(false));
            },
            {
                enableHighAccuracy: true,
                timeout: 5000,
                maximumAge: 60000,
            }
        );
    };

    const handleCopyCoordinates = async () => {
        if (!hasLocation) return;

        try {
            await navigator.clipboard.writeText(`${normalizedLocation.lat.toFixed(6)}, ${normalizedLocation.lon.toFixed(6)}`);
            toast.success(t('location.coordinates_copied'));
        } catch (error) {
            toast.error(t('location.failed_copy'));
        }
    };

    const handleSetLocation = async () => {
        if (!canSave) return;

        try {
            await dispatch(storeLocation({ socket, location, altitude, locationId })).unwrap();
            setSavedState({
                lat: Number(location.lat),
                lon: Number(location.lon),
                altitude: Number(altitude || 0),
                locationId: locationId || null,
            });
        } catch (error) {
            // Toast handled in slice
        }
    };

    return (
        <Paper elevation={3} sx={{ padding: 2, marginTop: 0 }}>
            <Alert severity="info" role="status" aria-live="polite">
                <AlertTitle>{t('location.title')}</AlertTitle>
                {t('location.subtitle')}
            </Alert>

            <Grid container spacing={2} columns={{ xs: 1, sm: 1, md: 1, lg: 2 }} sx={{ pt: 2 }}>
                <Grid size={{ xs: 1, md: 1 }}>
                    <Box
                        sx={{
                            p: 2,
                            backgroundColor: 'background.paper',
                            borderRadius: 1,
                            boxShadow: 1,
                            border: '1px solid',
                            borderColor: 'divider',
                            height: '100%',
                        }}
                    >
                        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
                            <Typography variant="h6" sx={{ color: 'primary.main', fontWeight: 700 }}>
                                {t('location.ground_station_location')}
                            </Typography>
                            {statusChip}
                        </Stack>

                        <Grid container spacing={2}>
                            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                                    {t('location.coordinates')}
                                </Typography>
                                {locationLoading && !hasLocation ? (
                                    <Stack spacing={1}>
                                        <Skeleton variant="rounded" height={22} />
                                        <Skeleton variant="rounded" height={22} />
                                        <Skeleton variant="rounded" height={22} />
                                    </Stack>
                                ) : (
                                    <Stack spacing={1.25}>
                                        <Box>
                                            <Typography variant="caption" color="text.secondary">{t('location.latitude')}</Typography>
                                            <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'text.primary' }}>
                                                {hasLocation ? `${normalizedLocation.lat.toFixed(6)}deg` : t('location.state_unavailable', { defaultValue: 'Unavailable' })}
                                            </Typography>
                                        </Box>
                                        <Box>
                                            <Typography variant="caption" color="text.secondary">{t('location.longitude')}</Typography>
                                            <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'text.primary' }}>
                                                {hasLocation ? `${normalizedLocation.lon.toFixed(6)}deg` : t('location.state_unavailable', { defaultValue: 'Unavailable' })}
                                            </Typography>
                                        </Box>
                                        <Box>
                                            <Typography variant="caption" color="text.secondary">{t('location.qth_locator')}</Typography>
                                            <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'text.primary' }}>
                                                {hasLocation ? (qth || 'N/A') : t('location.state_unavailable', { defaultValue: 'Unavailable' })}
                                            </Typography>
                                        </Box>
                                    </Stack>
                                )}
                            </Grid>

                            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                                    {t('location.location_details')}
                                </Typography>
                                <Stack spacing={1.25}>
                                    <Box>
                                        <Typography variant="caption" color="text.secondary">{t('location.altitude')}</Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'text.primary' }}>
                                            {elevationText}
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="caption" color="text.secondary">{t('location.timezone')}</Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'text.primary' }}>
                                            {`${timezoneName} (${tzOffsetDisplay})`}
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="caption" color="text.secondary">{t('location.nearest_city')}</Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'text.primary' }}>
                                            {nearestCityText}
                                        </Typography>
                                    </Box>
                                </Stack>
                            </Grid>

                            <Grid size={{ xs: 12, sm: 12, md: 4 }}>
                                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                                    {t('location.actions')}
                                </Typography>
                                <Box
                                    sx={{
                                        position: { md: 'sticky' },
                                        top: { md: 16 },
                                        border: '1px solid',
                                        borderColor: 'divider',
                                        borderRadius: 1,
                                        p: 1.5,
                                    }}
                                >
                                    <Stack spacing={1.2}>
                                        <Button
                                            variant="contained"
                                            color="secondary"
                                            fullWidth
                                            disabled={locationLoading || locationSaving}
                                            aria-label={t('location.get_current_location')}
                                            onClick={getCurrentLocation}
                                        >
                                            {locationLoading
                                                ? t('location.state_locating', { defaultValue: 'Locating...' })
                                                : t('location.get_current_location')}
                                        </Button>

                                        <Button
                                            variant="outlined"
                                            color="primary"
                                            fullWidth
                                            disabled={!hasLocation}
                                            aria-label={t('location.copy_coordinates')}
                                            onClick={handleCopyCoordinates}
                                        >
                                            {t('location.copy_coordinates')}
                                        </Button>

                                        <Divider />

                                        <Button
                                            variant="contained"
                                            color="primary"
                                            fullWidth
                                            disabled={!canSave}
                                            aria-label={t('location.save_location')}
                                            onClick={handleSetLocation}
                                        >
                                            {locationSaving
                                                ? t('location.state_saving', { defaultValue: 'Saving...' })
                                                : t('location.save_location')}
                                        </Button>

                                        {!hasLocation && (
                                            <Typography variant="caption" color="warning.main">
                                                {t('location.map_empty_hint', { defaultValue: 'No location selected yet. Click the map or use current location.' })}
                                            </Typography>
                                        )}
                                    </Stack>
                                </Box>
                            </Grid>
                        </Grid>
                    </Box>
                </Grid>

                <Grid size={{ xs: 1, md: 1 }}>
                    <Box sx={{ px: 0.5, pb: 1.5 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                            {t('location.map_section_title', { defaultValue: 'Map Selection' })}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                            {t('location.map_instruction', { defaultValue: 'Click anywhere on the map to set your station coordinates.' })}
                        </Typography>
                    </Box>

                    <Box
                        sx={{
                            width: '100%',
                            height: { xs: 380, sm: 420, md: 500 },
                            borderRadius: 1,
                            border: '1px solid',
                            borderColor: 'divider',
                            boxShadow: 1,
                        }}
                    >
                        <MapContainer
                            center={mapCenter}
                            zoom={mapZoom}
                            maxZoom={10}
                            minZoom={1}
                            dragging
                            whenReady={handleWhenReady}
                            style={{ height: '100%', width: '100%' }}
                        >
                            <TileLayer
                                url={getTileLayerById('satellite').url}
                                attribution="Map tiles by Carto, under CC BY 3.0. Data by OpenStreetMap, under ODbL."
                            />
                            <MapClickHandler onClick={handleMapClick} />

                            {hasLocation && (
                                <Marker position={normalizedLocation} icon={customIcon}>
                                    <Popup>{t('location.your_selected_location')}</Popup>
                                </Marker>
                            )}

                            {hasLocation && polylines.map((polyline, index) => (
                                <Polyline
                                    key={index}
                                    positions={polyline}
                                    color="white"
                                    opacity={0.8}
                                    lineCap="round"
                                    lineJoin="round"
                                    dashArray="2, 2"
                                    dashOffset="10"
                                    interactive={false}
                                    smoothFactor={1}
                                    noClip={false}
                                    className="leaflet-interactive"
                                    weight={1}
                                />
                            ))}

                            {hasLocation && (
                                <Circle
                                    center={normalizedLocation}
                                    radius={400000}
                                    pathOptions={{
                                        color: 'white',
                                        fillOpacity: 0,
                                        weight: 1,
                                        opacity: 0.8,
                                        dashArray: '2, 2',
                                    }}
                                />
                            )}
                        </MapContainer>
                    </Box>

                    <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
                        <Button
                            variant="outlined"
                            size="small"
                            disabled={!hasLocation}
                            aria-label={t('location.map_recenter', { defaultValue: 'Recenter map' })}
                            onClick={() => {
                                if (hasLocation) reCenterMap(normalizedLocation.lat, normalizedLocation.lon);
                            }}
                        >
                            {t('location.map_recenter', { defaultValue: 'Recenter' })}
                        </Button>
                    </Stack>
                    {!hasLocation && (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                            {t('location.map_empty_state', { defaultValue: 'No marker selected yet.' })}
                        </Typography>
                    )}
                </Grid>
            </Grid>
        </Paper>
    );
};

export default LocationPage;
