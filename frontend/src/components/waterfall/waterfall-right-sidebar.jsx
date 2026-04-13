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

import React, { useEffect, useState } from 'react';
import { Box, Divider, IconButton, Slider, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import { AutoScaleOnceIcon, AutoDBIcon } from '../common/custom-icons.jsx';
import { setAutoDBRange, setDbRange } from './waterfall-slice.jsx';

const MIN_ZOOM = 1;
const MAX_ZOOM = 20;
const ZOOM_STEP = 0.1;

const WaterfallRightSidebar = ({ workerRef, waterfallControlRef, dimensions }) => {
    const theme = useTheme();
    const dispatch = useDispatch();
    const [zoomSliderValue, setZoomSliderValue] = useState(1);

    const {
        dbRange,
        isStreaming,
        autoDBRange,
        waterFallScaleX,
        showRightSideWaterFallAccessories,
        packetsDrawerOpen,
        packetsDrawerHeight,
    } = useSelector((state) => ({
        dbRange: state.waterfall.dbRange,
        isStreaming: state.waterfall.isStreaming,
        autoDBRange: state.waterfall.autoDBRange,
        waterFallScaleX: state.waterfall.waterFallScaleX,
        showRightSideWaterFallAccessories: state.waterfall.showRightSideWaterFallAccessories,
        packetsDrawerOpen: state.waterfall.packetsDrawerOpen,
        packetsDrawerHeight: state.waterfall.packetsDrawerHeight,
    }), shallowEqual);

    useEffect(() => {
        const nextZoom = Number(waterFallScaleX);
        if (Number.isFinite(nextZoom)) {
            setZoomSliderValue(nextZoom);
        }
    }, [waterFallScaleX]);

    if (!showRightSideWaterFallAccessories) {
        return null;
    }

    // Calculate height based on actual bottom container height
    // The bottom container consists of: status bar (30px) + drawer handle (32px) + drawer content (if open)
    const statusBarHeight = 30;
    const drawerHandleHeight = 32;
    const drawerContentHeight = packetsDrawerOpen ? packetsDrawerHeight : 0;
    const bottomContainerHeight = statusBarHeight + drawerHandleHeight + drawerContentHeight;
    const additionalOffset = 72;

    // Total offset is bottom container height + additional offset
    // ResizeObserver dimensions already account for fullscreen vs normal mode
    const totalOffset = bottomContainerHeight + additionalOffset;
    const rawHeight = (dimensions?.height || 0) - totalOffset;
    const sidebarHeight = Math.max(200, rawHeight);

    const handleAutoScaleOnce = () => {
        if (workerRef.current) {
            workerRef.current.postMessage({ cmd: 'autoScaleDbRange' });
        }
    };

    const handleZoomChange = (_, newValue) => {
        if (Array.isArray(newValue)) {
            return;
        }

        const nextZoom = Number(newValue);
        if (!Number.isFinite(nextZoom)) {
            return;
        }

        setZoomSliderValue(nextZoom);
        waterfallControlRef?.current?.setZoomScale?.(nextZoom);
    };

    return (
        <Box
            className={'right-vertical-bar'}
            sx={{
                width: '64px',
                minWidth: '64px',
                maxWidth: '64px',
                height: `${sidebarHeight}px`,
                position: 'relative',
                borderLeft: `1px solid ${theme.palette.border.main}`,
                backgroundColor: theme.palette.background.paper,
                display: 'flex',
                flexDirection: 'column',
                flexShrink: 0,
                overflowY: 'auto',
            }}
        >
            <Box sx={{ px: 0.5, py: 1, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 120 }}>
                <Typography
                    variant="overline"
                    sx={{
                        lineHeight: 1.2,
                        letterSpacing: 0.6,
                        width: '100%',
                        textAlign: 'center',
                        color: 'text.secondary',
                    }}
                >
                    Zoom
                </Typography>
                <Typography
                    variant="caption"
                    sx={{
                        width: '100%',
                        textAlign: 'center',
                        fontFamily: 'Monospace',
                        color: 'text.secondary',
                        mb: 0.25,
                    }}
                >
                    {MAX_ZOOM.toFixed(1)}x
                </Typography>
                <Slider
                    orientation="vertical"
                    value={zoomSliderValue}
                    onChange={handleZoomChange}
                    min={MIN_ZOOM}
                    max={MAX_ZOOM}
                    step={ZOOM_STEP}
                    valueLabelDisplay="auto"
                    valueLabelFormat={(value) => `${Number(value).toFixed(1)}x`}
                    sx={{
                        width: '24px',
                        margin: '0 auto',
                        flex: 1,
                        minHeight: 90,
                        color: 'primary.main',
                        '& .MuiSlider-thumb': {
                            width: 22,
                            height: 22,
                        },
                        '& .MuiSlider-track': {
                            width: 9,
                            opacity: 0.85,
                        },
                        '& .MuiSlider-rail': {
                            width: 9,
                            opacity: 0.28,
                            color: 'text.secondary',
                        },
                        '& .MuiSlider-valueLabel': {
                            fontSize: '0.7rem',
                            fontFamily: 'Monospace',
                            backgroundColor: theme.palette.background.default,
                            color: theme.palette.text.primary,
                            border: `1px solid ${theme.palette.border.main}`,
                        },
                    }}
                />
                <Typography
                    variant="caption"
                    sx={{
                        width: '100%',
                        textAlign: 'center',
                        fontFamily: 'Monospace',
                        color: 'text.secondary',
                        mt: 0.25,
                    }}
                >
                    {MIN_ZOOM.toFixed(1)}x
                </Typography>
            </Box>

            <Divider sx={{ borderColor: theme.palette.border.main, mx: 0.5 }} />

            <Box sx={{ px: 0.5, py: 1, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 120 }}>
                <Typography
                    variant="overline"
                    sx={{
                        lineHeight: 1.2,
                        letterSpacing: 0.6,
                        width: '100%',
                        textAlign: 'center',
                        color: 'text.secondary',
                    }}
                >
                    Range
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'center', mb: 0.5 }}>
                    <Tooltip title="Auto once" placement="left">
                        <span>
                            <IconButton
                                disabled={!isStreaming}
                                onClick={handleAutoScaleOnce}
                                sx={{
                                    borderRadius: 1,
                                    width: 28,
                                    height: 28,
                                    color: autoDBRange ? 'success.main' : 'text.secondary',
                                    '&:hover': {
                                        backgroundColor: 'action.hover',
                                    },
                                    '&.Mui-disabled': {
                                        color: 'action.disabled',
                                    },
                                }}
                            >
                                <AutoScaleOnceIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                    <Tooltip title="Auto dB" placement="left">
                        <span>
                            <IconButton
                                disabled={!isStreaming}
                                onClick={() => dispatch(setAutoDBRange(!autoDBRange))}
                                sx={{
                                    borderRadius: 1,
                                    width: 28,
                                    height: 28,
                                    color: autoDBRange ? 'success.main' : 'text.secondary',
                                    '&:hover': {
                                        backgroundColor: 'action.hover',
                                    },
                                    '&.Mui-disabled': {
                                        color: 'action.disabled',
                                    },
                                }}
                            >
                                <AutoDBIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                </Stack>
                <Typography
                    variant="caption"
                    sx={{
                        width: '100%',
                        textAlign: 'center',
                        fontFamily: 'Monospace',
                        color: 'text.secondary',
                        mb: 0.25,
                    }}
                >
                    {dbRange[1]} dB
                </Typography>
                <Slider
                    disabled={!isStreaming}
                    orientation="vertical"
                    value={dbRange}
                    onChange={(e, newValue) => {
                        dispatch(setDbRange(newValue));
                    }}
                    min={-120}
                    max={30}
                    step={1}
                    valueLabelDisplay="auto"
                    valueLabelFormat={(value) => `${value} dB`}
                    sx={{
                        width: '24px',
                        margin: '0 auto',
                        flex: 1,
                        minHeight: 90,
                        color: autoDBRange ? 'success.main' : 'info.main',
                        '& .MuiSlider-thumb': {
                            width: 22,
                            height: 22,
                        },
                        '& .MuiSlider-track': {
                            width: 9,
                            opacity: 0.85,
                        },
                        '& .MuiSlider-rail': {
                            width: 9,
                            opacity: 0.28,
                            color: 'text.secondary',
                        },
                        '& .MuiSlider-valueLabel': {
                            fontSize: '0.7rem',
                            fontFamily: 'Monospace',
                            backgroundColor: theme.palette.background.default,
                            color: theme.palette.text.primary,
                            border: `1px solid ${theme.palette.border.main}`,
                        },
                    }}
                />
                <Typography
                    variant="caption"
                    sx={{
                        width: '100%',
                        textAlign: 'center',
                        fontFamily: 'Monospace',
                        color: 'text.secondary',
                        mt: 0.25,
                    }}
                >
                    {dbRange[0]} dB
                </Typography>
            </Box>
        </Box>
    );
};

export default React.memo(WaterfallRightSidebar);
