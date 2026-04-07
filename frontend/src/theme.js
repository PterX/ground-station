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



import {createTheme} from "@mui/material";
import { getThemeConfig } from './themes/theme-configs.js';

export function setupTheme(themeName = 'dark') {
    // Get the theme configuration
    const config = getThemeConfig(themeName);

    // Determine if theme is dark mode for component overrides
    const isDark = config.mode === 'dark';

    const palette = {
        mode: config.mode,
        ...config,
    }

    return createTheme({
        palette,
        cssVariables: {
            colorSchemeSelector: 'data-toolpad-color-scheme',
        },
        shape: {
            borderRadius: 6,
        },
        typography: {
            //htmlFontSize: 16,
            fontFamily: "Roboto, Arial, sans-serif",
            // h1: {
            //     fontSize: "3rem",
            // },
            // h2: {
            //     fontSize: "2.7rem",
            // },
            // h3: {
            //     fontSize: "2.5rem",
            // },
            // body1: {
            //     fontSize: "1.4rem",
            // },
            // body2: {
            //     fontSize: "1.2rem",
            // },
            // body3: {
            //     fontSize: "1.25rem",
            // },
        },
        components: {
            MuiCssBaseline: {
                styleOverrides: (theme) => {
                    const resizeHandleFill = theme.palette.mode === 'dark' ? '%23E6EDF5' : '%2330384A';
                    const resizeHandleShadow = theme.palette.mode === 'dark'
                        ? 'drop-shadow(0 0 1px rgba(0, 0, 0, 0.7))'
                        : 'drop-shadow(0 0 1px rgba(255, 255, 255, 0.7))';

                    return `
                    /* React Grid Layout styles */
                    .react-resizable-handle {
                        z-index: 1000;
                        opacity: 0.95;
                        filter: ${resizeHandleShadow};
                        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 6 6'%3E%3Cg opacity='0.88'%3E%3Cpath d='M6 6L0 6L0 4.2L4 4.2L4.2 4.2L4.2 0L6 0L6 6Z' fill='${resizeHandleFill}'/%3E%3C/g%3E%3C/svg%3E");
                    }
                    .react-grid-item.react-draggable-dragging {
                        opacity: 0.9;
                        z-index: 1000;
                        box-shadow: 0 8px 24px ${theme.palette.mode === 'dark' ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.3)'};
                        transition: box-shadow 0.2s ease;
                    }
                    .react-grid-draggable {
                        border-radius: 0;
                        cursor: grab;
                        user-select: none;
                        transition: background-color 0.15s ease, box-shadow 0.15s ease;
                        background-image:
                            repeating-linear-gradient(
                                90deg,
                                transparent,
                                transparent 3px,
                                ${theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)'} 3px,
                                ${theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.03)' : 'rgba(0, 0, 0, 0.02)'} 4px
                            );
                    }
                    .react-grid-draggable:hover {
                        background-color: ${theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)'};
                        box-shadow: inset 0 1px 3px ${theme.palette.mode === 'dark' ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.1)'};
                    }
                    .react-grid-draggable:active {
                        cursor: grabbing;
                        background-color: ${theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.05)'};
                        box-shadow: inset 0 2px 4px ${theme.palette.mode === 'dark' ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.15)'};
                    }

                    /* Leaflet map styles */
                    .leaflet-tooltip-bottom::before {
                        border-bottom-color: ${theme.palette.background.default} !important;
                    }
                    .leaflet-tooltip {
                        opacity: 0.9 !important;
                    }
                    .leaflet-control-attribution {
                        display: none;
                        background-color: ${theme.palette.background.paper};
                        color: ${theme.palette.text.secondary};
                        z-index: 3001;
                    }
                    .leaflet-container {
                        background-color: ${theme.palette.background.default} !important;
                    }
                    .leaflet-container.overview-map,
                    .leaflet-container.target-map,
                    .leaflet-container.satellite-details-map,
                    .leaflet-container.overview-map .leaflet-pane,
                    .leaflet-container.overview-map .leaflet-pane *,
                    .leaflet-container.target-map .leaflet-pane,
                    .leaflet-container.target-map .leaflet-pane *,
                    .leaflet-container.satellite-details-map .leaflet-pane,
                    .leaflet-container.satellite-details-map .leaflet-pane * {
                        cursor: default !important;
                    }
                    .leaflet-container.overview-map .leaflet-marker-icon,
                    .leaflet-container.target-map .leaflet-marker-icon,
                    .leaflet-container.satellite-details-map .leaflet-marker-icon {
                        cursor: pointer !important;
                    }
                    .leaflet-container.overview-map .overview-satellite-test-icon,
                    .leaflet-container.overview-map .overview-satellite-test-icon *,
                    .leaflet-container.overview-map .overview-satellite-dim-icon,
                    .leaflet-container.overview-map .overview-satellite-dim-icon *,
                    .leaflet-container.target-map .overview-satellite-test-icon,
                    .leaflet-container.target-map .overview-satellite-test-icon *,
                    .leaflet-container.target-map .overview-satellite-dim-icon,
                    .leaflet-container.target-map .overview-satellite-dim-icon *,
                    .leaflet-container.satellite-details-map .overview-satellite-test-icon,
                    .leaflet-container.satellite-details-map .overview-satellite-test-icon *,
                    .leaflet-container.satellite-details-map .overview-satellite-dim-icon,
                    .leaflet-container.satellite-details-map .overview-satellite-dim-icon * {
                        cursor: pointer !important;
                    }
                    .leaflet-control-fullscreen {
                        display: none;
                    }
                    .leaflet-link {
                        right: 8px;
                        position: absolute;
                    }

                    /* Custom application styles */
                    .window-title-bar {
                        background-color: ${theme.palette.background.paper};
                    }
                    .attribution {
                        color: ${theme.palette.text.secondary};
                        font-size: 12px;
                        line-height: 20px;
                    }
                    .truncate {
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        max-width: 1000px;
                        display: block;
                    }
                    .pointer-cursor {
                        cursor: pointer;
                    }

                    /* VSCode controller */
                    .vsc-controller {
                        display: none !important;
                    }

                    /* Tooltip satellite - interactive tooltips */
                    .tooltip-satellite {
                        pointer-events: auto !important;
                    }
                    .tooltip-satellite button {
                        pointer-events: auto !important;
                    }
                    .tooltip-satellite button.Mui-disabled {
                        pointer-events: none !important;
                    }
                `;
                },
            },
            MuiDrawer: {
                styleOverrides: {
                    paper: {
                        backgroundColor: isDark ? "#1e1e1e" : "#f5f5f5",
                        borderRight: isDark ? "1px solid #4b4b4b" : "1px solid #e0e0e0",
                    },
                },
            },
            MuiAppBar: {
                styleOverrides: {
                    root: ({ theme }) => ({
                        backgroundColor: isDark
                            ? theme.palette.background.elevated
                            : theme.palette.primary.main,
                        borderBottom: `1px solid ${theme.palette.border.main}`,
                        boxShadow: isDark
                            ? '0 2px 4px rgba(0, 0, 0, 0.5)'
                            : '0 2px 8px rgba(0, 0, 0, 0.15)',
                        backdropFilter: 'blur(4px)',
                    }),
                },
            },
            MuiToolbar: {
                styleOverrides: {
                    root: {
                        minHeight: '52px',
                        '@media (min-width: 600px)': {
                            minHeight: '52px',
                        },
                    },
                },
            },
            MuiSelect: {
                styleOverrides: {
                    root: ({ theme }) => ({
                        backgroundColor: theme.palette.background.paper,
                        //fontFamily: "Monospace, monospace",
                        //fontSize: "0.8rem",
                        //fontSpacing: "0.05rem",
                    }),
                },
            },
            MuiMenuItem: {
                styleOverrides: {
                    root: {
                        //fontFamily: "Monospace, monospace",
                        //fontSize: "0.8rem",
                        //fontSpacing: "0.05rem",
                    }
                },
            },
            MuiAutocomplete: {
                styleOverrides: {
                    root: ({ theme }) => ({
                        backgroundColor: theme.palette.background.paper,
                    }),
                },
            },
            MuiListSubheader: {
                styleOverrides: {
                    root: ({ theme }) => ({
                        backgroundColor: theme.palette.background.elevated,
                    }),
                },
            },
            MuiFilledInput: {
                styleOverrides: {
                    root: ({ theme }) => ({
                        backgroundColor: theme.palette.background.paper,
                    }),
                },
            },
            MuiTextField: {
                styleOverrides: {
                    root: ({ theme }) => ({
                        backgroundColor: theme.palette.background.paper,
                    }),
                },
            },
            MuiFormHelperText: {
                styleOverrides: {
                    root: {
                        backgroundColor: 'transparent',
                        '&.MuiFormHelperText-contained': {
                            backgroundColor: 'transparent',
                        },
                        '&.MuiFormHelperText-sizeSmall': {
                            backgroundColor: 'transparent',
                        },
                    }
                },
            }
            // MuiAppBar: {
            //     styleOverrides: {
            //         backgroundColor: "#1e1e1e",
            //     }
            // },
            // MuiButton: {
            //     styleOverrides: {
            //         borderRadius: 20,
            //         fontWeight: "bold",
            //     },
            //     defaultProps: {
            //         variant: "contained",
            //         disableElevation: true,
            //     },
            // },
            // MuiStack: {
            //     defaultProps: {
            //         gap: 2,
            //     },
            // },
        },
    });
}
