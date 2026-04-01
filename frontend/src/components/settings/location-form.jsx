
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
    Box,
    Button,
    Typography,
    Alert,
    AlertTitle,
    Paper
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import {MapContainer, TileLayer, Marker, Popup, Polyline, Circle, useMapEvents} from 'react-leaflet';
import Grid from '@mui/material/Grid';
import { toast } from '../../utils/toast-with-timestamp.jsx';
import { useSocket } from '../common/socket.jsx';
import { getMaidenhead } from '../common/common.jsx';
import { useDispatch, useSelector } from 'react-redux';
import {
    fetchLocationForUserId,
    setLocation,
    setPolylines,
    setQth,
    setLocationLoading,
    storeLocation,
    setAltitude,
} from './location-slice.jsx';
import {getTileLayerById} from "../common/tile-layers.jsx";
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

const createCustomIcon = () => {
    // SVG marker with enhanced shadow as data URI
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
        shadowAnchor: null
    });
};

// Try multiple fallback approaches for marker icons
const setupMarkerIcons = () => {
    try {
        // First attempt: Use CDN with fallback
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

// Initialize marker icons
setupMarkerIcons();

// Custom icon instance with shadow - you can choose between the two approaches
const customIcon = createCustomIcon(); // Integrated shadow

function MapClickHandler({ onClick }) {
    // Listen for map clicks
    useMapEvents({
        click: onClick,
    });
    return null;
}

const LocationPage = () => {
    const { socket } = useSocket();
    const dispatch = useDispatch();
    const [nearestCity, setNearestCity] = React.useState('');
    const mapRef = React.useRef(null);
    const { t } = useTranslation('settings');

    // Grab data from Redux
    const {
        locationLoading,
        location,
        locationId,
        qth,
        polylines,
        altitude,
    } = useSelector((state) => state.location);

    // Use local display location - defaults to 0,0 if Redux location is null
    // This prevents polluting Redux with temporary display values
    const displayLocation = location || { lat: 0, lon: 0 };

    // On location change, fetch the nearest city
    useEffect(() => {
        if (location && location.lat != null && location.lon != null) {
            getNearestCity(location.lat, location.lon)
                .then((city) => {
                    setNearestCity(city);
                })
                .catch(() => {});
        }
    }, [location]);

    // Recompute polylines when the location changes. Alternatively, you can handle this in the slice.
    useEffect(() => {
        if (location && location.lat != null && location.lon != null) {
            const horizontalLine = [
                [location.lat, -270],
                [location.lat, 270],
            ];
            const verticalLine = [
                [-90, location.lon],
                [90, location.lon],
            ];
            dispatch(setPolylines([horizontalLine, verticalLine]));
            dispatch(setQth(getMaidenhead(location.lat, location.lon)));
        } else {
            // Clear polylines when location is null
            dispatch(setPolylines([]));
        }
    }, [location, dispatch]);

    const handleMapClick = async (e) => {
        const { lat, lng } = e.latlng;
        dispatch(setLocation({ lat, lon: lng }));
        dispatch(setQth(getMaidenhead(lat, lng)));
        reCenterMap(lat, lng);
        const city = await getNearestCity(lat, lng);
        setNearestCity(city);
    };

    const handleWhenReady = (map) => {
        // Use ref instead of global variable
        mapRef.current = map.target;
    };

    const reCenterMap = (lat, lon) => {
        if (mapRef.current) {
            mapRef.current.setView([lat, lon], mapRef.current.getZoom());
        }
    };

    // Add this function to get nearest city
    const getNearestCity = async (lat, lon) => {
        try {
            const response = await fetch(
                `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
            );
            const data = await response.json();
            return data.city || data.locality || data.principalSubdivision || 'Unknown';
        } catch (error) {
            console.error('Error fetching city:', error);
            return 'Unknown';
        }
    };

    const getElevation = async (lat, lon) => {
        const response = await fetch(
            `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lon}`
        );
        const data = await response.json();
        return data.results[0].elevation; // Returns elevation in meters
    };

    useEffect(() => {
        if (mapRef.current && location && location.lat != null && location.lon != null) {
            mapRef.current.invalidateSize();
            reCenterMap(location.lat, location.lon);
        }
    }, [location]);

    const getCurrentLocation = async () => {
        dispatch(setLocationLoading(true));
        if (!navigator.geolocation) {
            toast.warning(t('location.geolocation_not_supported'));
            dispatch(setLocationLoading(false));
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const { latitude, longitude, altitude } = position.coords;

                dispatch(setLocation({
                    lat: latitude,
                    lon: longitude,
                }));

                if (altitude != null) {
                    dispatch(setAltitude(altitude));
                } else {
                    getElevation(latitude, longitude)
                        .then((elevation) => {
                            dispatch(setAltitude(elevation));
                        })
                        .catch((error) => {
                            console.error('Error fetching elevation:', error);
                        }
                        )
                }

                dispatch(setQth(getMaidenhead(latitude, longitude)));

                reCenterMap(latitude, longitude);
                dispatch(setLocationLoading(false));

                toast.success(t('location.location_retrieved'));
            },
            (error) => {
                toast.error(t('location.failed_get_location'));
                dispatch(setLocationLoading(false));
            },
            {
                enableHighAccuracy: true,
                timeout: 5000,
                maximumAge: 60000
            }
        );
    };

    const handleSetLocation = () => {
        dispatch(storeLocation({socket, location: displayLocation, altitude, locationId}));
    }

    return (
        <Paper elevation={3} sx={{ padding: 2, marginTop: 0 }}>
            <Alert severity="info">
                <AlertTitle>{t('location.title')}</AlertTitle>
                {t('location.subtitle')}
            </Alert>
            <Grid container spacing={1} columns={{ xs: 1, sm: 1, md: 1, lg: 2 }} sx={{ pt: 2 }}>
                <Grid size={{ xs: 1, md: 1 }}>
                    <Box
                        sx={{
                            mt: 0,
                            p: 2,
                            backgroundColor: 'background.paper',
                            borderRadius: 1,
                            boxShadow: 1,
                            border: '1px solid',
                            borderColor: 'divider',
                            height: '100%',
                        }}
                    >
                        <Typography variant="h6" gutterBottom sx={{ mb: 3, color: 'primary.main' }}>
                            {t('location.ground_station_location')}
                        </Typography>

                        <Grid container spacing={2}>
                            {/* Coordinates Section */}
                            <Grid size={{ xs: 4, md: 4 }}>
                                <Typography variant="h6" gutterBottom sx={{ fontSize: '1rem', fontWeight: 600 }}>
                                    {t('location.coordinates')}
                                </Typography>
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <Box>
                                        <Typography variant="body2" color="text.secondary">
                                            {t('location.latitude')}
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
                                            {displayLocation.lat?.toFixed(6)}°
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="body2" color="text.secondary">
                                            {t('location.longitude')}
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
                                            {displayLocation.lon?.toFixed(6)}°
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="body2" color="text.secondary">
                                            {t('location.qth_locator')}
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
                                            {qth || 'N/A'}
                                        </Typography>
                                    </Box>
                                </Box>
                            </Grid>

                            {/* Location Details Section */}
                            <Grid size={{ xs: 4, md: 4 }}>
                                <Typography variant="h6" gutterBottom sx={{ fontSize: '1rem', fontWeight: 600 }}>
                                    {t('location.location_details')}
                                </Typography>
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <Box>
                                        <Typography variant="body2" color="text.secondary">
                                            {t('location.altitude')}
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
                                            {t('location.altitude_asl', { altitude })}
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="body2" color="text.secondary">
                                            {t('location.timezone')}
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
                                            {/* Placeholder for timezone */}
                                            UTC{Intl.DateTimeFormat().resolvedOptions().timeZone ?
                                            new Date().getTimezoneOffset() > 0 ?
                                                `-${Math.abs(new Date().getTimezoneOffset() / 60)}` :
                                                `+${Math.abs(new Date().getTimezoneOffset() / 60)}`
                                            : ''}
                                        </Typography>
                                    </Box>
                                    <Box>
                                        <Typography variant="body2" color="text.secondary">
                                            {t('location.nearest_city')}
                                        </Typography>
                                        <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 500 }}>
                                            {nearestCity}
                                        </Typography>
                                    </Box>
                                </Box>
                            </Grid>

                            {/* Action Buttons Section */}
                            <Grid size={{ xs: 4, md: 4 }}>
                                <Typography variant="h6" gutterBottom sx={{ fontSize: '1rem', fontWeight: 600 }}>
                                    {t('location.actions')}
                                </Typography>
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <Button
                                        variant="contained"
                                        color="secondary"
                                        loading={locationLoading}
                                        fullWidth
                                        onClick={async () => {
                                            try {
                                                await getCurrentLocation();
                                            } catch (error) {
                                                toast.error(t('location.failed_copy'));
                                            }
                                        }}
                                    >
                                        {t('location.get_current_location')}
                                    </Button>
                                    <Button
                                        variant="outlined"
                                        color="primary"
                                        fullWidth
                                        onClick={() => {
                                            // Placeholder for export functionality
                                            navigator.clipboard.writeText(`${displayLocation.lat?.toFixed(6)}, ${displayLocation.lon?.toFixed(6)}`);
                                            toast.success(t('location.coordinates_copied'));
                                        }}
                                    >
                                        {t('location.copy_coordinates')}
                                    </Button>
                                </Box>
                            </Grid>
                        </Grid>
                    </Box>
                </Grid>
                <Grid size={{ xs: 1, md: 1 }}>
                    <Box
                        sx={{
                            width: { xs: '100%', sm: '100%', md: '100%', lg: '100%' },
                            height: '500px',
                            borderRadius: 1,
                            border: '1px solid #424242',
                            boxShadow: 1,

                        }}
                    >
                        <MapContainer
                            center={[displayLocation.lat, displayLocation.lon]}
                            zoom={2}
                            maxZoom={10}
                            whenReady={handleWhenReady}
                            minZoom={1}
                            dragging={true}
                            style={{ height: '100%', width: '100%' }}
                        >
                            <TileLayer
                                url={getTileLayerById("satellite")['url']}
                                attribution="Map tiles by Carto, under CC BY 3.0. Data by OpenStreetMap, under ODbL."
                            />
                            <MapClickHandler onClick={handleMapClick} />
                            {location && location.lat != null && location.lon != null && (
                                <Marker position={displayLocation} icon={customIcon}>
                                    <Popup>{t('location.your_selected_location')}</Popup>
                                </Marker>
                            )}
                            {location && location.lat != null && location.lon != null && polylines.map((polyline, index) => (
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
                            {location && location.lat != null && location.lon != null && (
                                <Circle
                                    center={displayLocation}
                                    radius={400000}
                                    pathOptions={{
                                        color: 'white',
                                        fillOpacity: 0,
                                        weight: 1,
                                        opacity: 0.8,
                                        dashArray: "2, 2",
                                    }}
                                />
                            )}
                        </MapContainer>
                    </Box>
                </Grid>
                <Grid size={{ xs: 6, md: 8 }} sx={{ pt: 2 }}>
                    <Button variant="contained" color="primary" onClick={() => handleSetLocation()}>
                        {t('location.save_location')}
                    </Button>
                </Grid>
            </Grid>
        </Paper>
    );
};

export default LocationPage;
