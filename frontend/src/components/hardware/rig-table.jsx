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


import * as React from 'react';
import Box from '@mui/material/Box';
import {
    Alert,
    AlertTitle,
    Button,
    FormControl,
    FormHelperText,
    InputLabel,
    MenuItem,
    Select,
    TextField,
    Typography
} from "@mui/material";
import { useTranslation } from 'react-i18next';
import Stack from "@mui/material/Stack";
import DialogTitle from "@mui/material/DialogTitle";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import {useSocket} from "../common/socket.jsx";
import {useDispatch, useSelector} from 'react-redux';
import {
    fetchRigs,
    deleteRigs,
    setSelected,
    submitOrEditRig,
    setOpenDeleteConfirm,
    setFormValues,
    setOpenAddDialog,
} from './rig-slice.jsx';
import { toast } from '../../utils/toast-with-timestamp.jsx';
import {DataGrid, gridClasses} from "@mui/x-data-grid";
import Paper from "@mui/material/Paper";


export default function RigTable() {
    const dispatch = useDispatch();
    const {socket} = useSocket();
    const {rigs, loading, selected, openDeleteConfirm, formValues, openAddDialog} = useSelector((state) => state.rigs);
    const { t } = useTranslation('hardware');
    const isEditing = Boolean(formValues.id);

    const defaultRig = {
        id: null,
        name: '',
        host: 'localhost',
        port: 4532,
        radiotype: 'rx',
        radio_mode: 'duplex',
        tx_control_mode: 'auto',
        retune_interval_ms: 2000,
        follow_downlink_tuning: false,
    };
    const [pageSize, setPageSize] = React.useState(10);
    const selectedRadioMode = formValues.radio_mode || 'duplex';
    const radioModeHelpKey = `rig.radio_mode_help_${selectedRadioMode}`;
    const selectedTxControlMode = formValues.tx_control_mode || 'auto';
    const txControlModeHelpKey = `rig.tx_mode_help_${selectedTxControlMode}`;

    const columns = [
        {field: 'name', headerName: t('rig.name'), flex: 1, minWidth: 150},
        {field: 'host', headerName: t('rig.host'), flex: 1, minWidth: 150},
        {
            field: 'port',
            headerName: t('rig.port'),
            type: 'number',
            flex: 1,
            minWidth: 80,
            align: 'right',
            headerAlign: 'right',
            valueFormatter: (value) => {
                return value;
            }
        },
        {field: 'radio_mode', headerName: t('rig.radio_mode'), flex: 1, minWidth: 150},
        {field: 'tx_control_mode', headerName: t('rig.tx_control_mode'), flex: 1, minWidth: 150},
        {
            field: 'retune_interval_ms',
            headerName: t('rig.retune_interval_ms'),
            flex: 1,
            minWidth: 140,
        },
        {
            field: 'follow_downlink_tuning',
            headerName: t('rig.follow_downlink_tuning'),
            flex: 1,
            minWidth: 170,
            valueFormatter: (params) => params?.value ? t('rig.enabled') : t('rig.disabled'),
        },
    ];

    // useEffect(() => {
    //     dispatch(fetchRigs({socket}));
    // }, [dispatch]);

    function handleFormSubmit() {
        if (formValues.id) {
            dispatch(submitOrEditRig({socket, formValues}))
                .unwrap()
                .then(() => {
                    toast.success(t('rig.edited_success'), {autoClose: 5000});
                })
                .catch((error) => {
                    toast.error(t('rig.error_editing'), {autoClose: 5000})
                });
        } else {
            dispatch(submitOrEditRig({socket, formValues}))
                .unwrap()
                .then(() => {
                    toast.success(t('rig.added_success'), {autoClose: 5000});
                })
                .catch((error) => {
                    toast.error(`${t('rig.error_adding')}: ${error}`, {autoClose: 5000})
                });
        }
        dispatch(setOpenAddDialog(false));
    }

    function handleDelete() {
        dispatch(deleteRigs({socket, selectedIds: selected}))
            .unwrap()
            .then(() => {
                dispatch(setSelected([]));
                dispatch(setOpenDeleteConfirm(false));
                toast.success(t('rig.deleted_success'), {autoClose: 5000});
            })
            .catch((error) => {
                toast.error(t('rig.error_deleting'), {autoClose: 5000});
            });
    }

    const handleChange = (e) => {
        const {name, value} = e.target;
        if (e.target.type === "number") {
            dispatch(setFormValues({...formValues, [name]: parseInt(value)}));
        } else {
            dispatch(setFormValues({...formValues, [name]: value}));
        }

    };

    const validationErrors = {};
    if (!formValues.name?.trim()) validationErrors.name = 'Required';
    if (!formValues.host?.trim()) validationErrors.host = 'Required';
    if (!formValues.port && formValues.port !== 0) {
        validationErrors.port = 'Required';
    } else if (Number(formValues.port) <= 0 || Number(formValues.port) > 65535) {
        validationErrors.port = 'Port must be 1-65535';
    }
    if (!formValues.retune_interval_ms && formValues.retune_interval_ms !== 0) {
        validationErrors.retune_interval_ms = 'Required';
    } else if (
        Number(formValues.retune_interval_ms) < 100
        || Number(formValues.retune_interval_ms) > 60000
    ) {
        validationErrors.retune_interval_ms = 'Retune interval must be 100-60000 ms';
    }
    const hasValidationErrors = Object.keys(validationErrors).length > 0;

    return (
        <Paper elevation={3} sx={{padding: 2, marginTop: 0}}>
            <Alert severity="info">
                <AlertTitle>{t('rig.title')}</AlertTitle>
                {t('rig.subtitle')}
            </Alert>
            <Box component="form" sx={{mt: 2}}>
                <Box sx={{width: '100%'}}>
                    <DataGrid
                        loading={loading}
                        rows={rigs}
                        columns={columns}
                        checkboxSelection
                        disableSelectionOnClick
                        selectionModel={selected}
                        onRowSelectionModelChange={(selected) => {
                            dispatch(setSelected(selected));
                        }}
                        initialState={{
                            pagination: {paginationModel: {pageSize: 5}},
                            sorting: {
                                sortModel: [{field: 'name', sort: 'desc'}],
                            },
                        }}
                        pageSize={pageSize}
                        pageSizeOptions={[5, 10, 25, {value: -1, label: 'All'}]}
                        onPageSizeChange={(newPageSize) => setPageSize(newPageSize)}
                        rowsPerPageOptions={[5, 10, 25]}
                        getRowId={(row) => row.id}
                        localeText={{
                            noRowsLabel: t('rig.no_rigs')
                        }}
                        sx={{
                            border: 0,
                            marginTop: 2,
                            [`& .${gridClasses.cell}:focus, & .${gridClasses.cell}:focus-within`]: {
                                outline: 'none',
                            },
                            [`& .${gridClasses.columnHeader}:focus, & .${gridClasses.columnHeader}:focus-within`]:
                                {
                                    outline: 'none',
                                },
                            '& .MuiDataGrid-overlay': {
                                fontSize: '0.875rem',
                                fontStyle: 'italic',
                                color: 'text.secondary',
                            },
                        }}
                    />
                    <Stack direction="row" spacing={2} style={{marginTop: 15}}>
                        <Button variant="contained" onClick={() => {
                            dispatch(setFormValues(defaultRig));
                            dispatch(setOpenAddDialog(true));
                        }}>
                            {t('rig.add')}
                        </Button>
                        <Button variant="contained" disabled={selected.length !== 1} onClick={() => {
                            const rigToEdit = rigs.find((rig) => rig.id === selected[0]);
                            if (rigToEdit) {
                                dispatch(setFormValues(rigToEdit));
                                dispatch(setOpenAddDialog(true));
                            }
                        }}>
                            {t('rig.edit')}
                        </Button>
                        <Button
                            variant="contained"
                            disabled={selected.length < 1}
                            color="error"
                            onClick={() => dispatch(setOpenDeleteConfirm(true))}
                        >
                            {t('rig.delete')}
                        </Button>
                    </Stack>
                    <Dialog
                        open={openAddDialog}
                        onClose={() => dispatch(setOpenAddDialog(false))}
                        fullWidth
                        maxWidth="sm"
                        PaperProps={{
                            sx: {
                                bgcolor: 'background.paper',
                                border: (theme) => `1px solid ${theme.palette.divider}`,
                                borderRadius: 2,
                            }
                        }}
                    >
                        <DialogTitle
                            sx={{
                                bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
                                borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
                                fontSize: '1.25rem',
                                fontWeight: 'bold',
                                py: 2.5,
                            }}
                        >
                            {isEditing ? t('rig.edit_dialog_title') : t('rig.add_dialog_title')}
                        </DialogTitle>
                        <DialogContent sx={{ bgcolor: 'background.paper', px: 3, py: 3 }}>
                            <Stack spacing={2} sx={{ mt: 3 }}>
                                <TextField
                                    autoFocus
                                    name="name"
                                    label={t('rig.name')}
                                    type="text"
                                    fullWidth
                                    size="small"
                                    value={formValues.name}
                                    onChange={handleChange}
                                    error={Boolean(validationErrors.name)}
                                    required
                                />
                                <TextField
                                    name="host"
                                    label={t('rig.host')}
                                    type="text"
                                    fullWidth
                                    size="small"
                                    value={formValues.host}
                                    onChange={handleChange}
                                    error={Boolean(validationErrors.host)}
                                    required
                                />
                                <TextField
                                    name="port"
                                    label={t('rig.port')}
                                    type="number"
                                    fullWidth
                                    size="small"
                                    value={formValues.port}
                                    onChange={handleChange}
                                    error={Boolean(validationErrors.port)}
                                    required
                                />
                                <FormControl fullWidth size="small">
                                    <InputLabel>{t('rig.radio_mode')}</InputLabel>
                                    <Select
                                        name="radio_mode"
                                        label={t('rig.radio_mode')}
                                        size="small"
                                        value={formValues.radio_mode || 'duplex'}
                                        onChange={handleChange}
                                    >
                                        <MenuItem value="monitor">{t('rig.radio_mode_monitor')}</MenuItem>
                                        <MenuItem value="uplink_only">{t('rig.radio_mode_uplink_only')}</MenuItem>
                                        <MenuItem value="simplex">{t('rig.radio_mode_simplex')}</MenuItem>
                                        <MenuItem value="duplex">{t('rig.radio_mode_duplex')}</MenuItem>
                                        <MenuItem value="ptt_guarded">{t('rig.radio_mode_ptt_guarded')}</MenuItem>
                                    </Select>
                                    <FormHelperText>{t(radioModeHelpKey)}</FormHelperText>
                                </FormControl>
                                <FormControl fullWidth size="small">
                                    <InputLabel>{t('rig.tx_control_mode')}</InputLabel>
                                    <Select
                                        name="tx_control_mode"
                                        label={t('rig.tx_control_mode')}
                                        size="small"
                                        value={formValues.tx_control_mode || 'auto'}
                                        onChange={handleChange}
                                    >
                                        <MenuItem value="auto">{t('rig.tx_mode_auto')}</MenuItem>
                                        <MenuItem value="vfo_switch">
                                            {t('rig.tx_mode_vfo_switch')}
                                        </MenuItem>
                                        <MenuItem value="split_tx_cmd">
                                            {t('rig.tx_mode_split_tx_cmd')}
                                        </MenuItem>
                                        <MenuItem value="vfo_explicit">
                                            {t('rig.tx_mode_vfo_explicit')}
                                        </MenuItem>
                                    </Select>
                                    <FormHelperText>{t(txControlModeHelpKey)}</FormHelperText>
                                </FormControl>
                                <TextField
                                    name="retune_interval_ms"
                                    label={t('rig.retune_interval_ms')}
                                    type="number"
                                    fullWidth
                                    size="small"
                                    value={formValues.retune_interval_ms ?? 2000}
                                    onChange={handleChange}
                                    error={Boolean(validationErrors.retune_interval_ms)}
                                    required
                                />
                                <FormHelperText>{t('rig.retune_interval_help')}</FormHelperText>
                                <FormControl fullWidth size="small">
                                    <InputLabel>{t('rig.follow_downlink_tuning')}</InputLabel>
                                    <Select
                                        name="follow_downlink_tuning"
                                        label={t('rig.follow_downlink_tuning')}
                                        size="small"
                                        value={Boolean(formValues.follow_downlink_tuning)}
                                        onChange={handleChange}
                                    >
                                        <MenuItem value={true}>{t('rig.enabled')}</MenuItem>
                                        <MenuItem value={false}>{t('rig.disabled')}</MenuItem>
                                    </Select>
                                    <FormHelperText>{t('rig.follow_downlink_tuning_help')}</FormHelperText>
                                </FormControl>
                            </Stack>
                        </DialogContent>
                        <DialogActions
                            sx={{
                                bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100',
                                borderTop: (theme) => `1px solid ${theme.palette.divider}`,
                                px: 3,
                                py: 2.5,
                                gap: 2,
                            }}
                        >
                            <Button
                                onClick={() => dispatch(setOpenAddDialog(false))}
                                variant="outlined"
                                sx={{
                                    borderColor: (theme) => theme.palette.mode === 'dark' ? 'grey.700' : 'grey.400',
                                    '&:hover': {
                                        borderColor: (theme) => theme.palette.mode === 'dark' ? 'grey.600' : 'grey.500',
                                        bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.800' : 'grey.200',
                                    },
                                }}
                            >
                                {t('rig.cancel')}
                            </Button>
                            <Button onClick={() => handleFormSubmit()} color="success" variant="contained" disabled={hasValidationErrors}>
                                {t('rig.submit')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                    <Dialog
                        open={openDeleteConfirm}
                        onClose={() => dispatch(setOpenDeleteConfirm(false))}
                        maxWidth="sm"
                        fullWidth
                        PaperProps={{
                            sx: {
                                bgcolor: 'background.paper',
                                borderRadius: 2,
                            }
                        }}
                    >
                        <DialogTitle
                            sx={{
                                bgcolor: 'error.main',
                                color: 'error.contrastText',
                                fontSize: '1.125rem',
                                fontWeight: 600,
                                py: 2,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1.5,
                            }}
                        >
                            <Box
                                component="span"
                                sx={{
                                    width: 24,
                                    height: 24,
                                    borderRadius: '50%',
                                    bgcolor: 'error.contrastText',
                                    color: 'error.main',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontWeight: 'bold',
                                    fontSize: '1rem',
                                }}
                            >
                                !
                            </Box>
                            {t('rig.confirm_deletion')}
                        </DialogTitle>
                        <DialogContent sx={{ px: 3, pt: 3, pb: 3 }}>
                            <Typography variant="body1" sx={{ mt: 2, mb: 2, color: 'text.primary' }}>
                                {t('rig.confirm_delete_message')}
                            </Typography>
                            <Typography variant="body2" sx={{ mb: 2, fontWeight: 600, color: 'text.secondary' }}>
                                {selected.length === 1 ? 'Rig to be deleted:' : `${selected.length} Rigs to be deleted:`}
                            </Typography>
                            <Box sx={{
                                maxHeight: 300,
                                overflowY: 'auto',
                                bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50',
                                borderRadius: 1,
                                border: (theme) => `1px solid ${theme.palette.divider}`,
                            }}>
                                {selected.map((id, index) => {
                                    const rig = rigs.find(r => r.id === id);
                                    if (!rig) return null;
                                    return (
                                        <Box
                                            key={id}
                                            sx={{
                                                p: 2,
                                                borderBottom: index < selected.length - 1 ? (theme) => `1px solid ${theme.palette.divider}` : 'none',
                                            }}
                                        >
                                            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1, color: 'text.primary' }}>
                                                {rig.name}
                                            </Typography>
                                            <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 1, columnGap: 2 }}>
                                                <Typography variant="body2" sx={{ fontSize: '0.813rem', color: 'text.secondary', fontWeight: 500 }}>
                                                    Host:
                                                </Typography>
                                                <Typography variant="body2" sx={{ fontSize: '0.813rem', color: 'text.primary' }}>
                                                    {rig.host}:{rig.port}
                                                </Typography>

                                                <Typography variant="body2" sx={{ fontSize: '0.813rem', color: 'text.secondary', fontWeight: 500 }}>
                                                    Radio Mode:
                                                </Typography>
                                                <Typography variant="body2" sx={{ fontSize: '0.813rem', color: 'text.primary' }}>
                                                    {rig.radio_mode || 'duplex'}
                                                </Typography>

                                                <Typography variant="body2" sx={{ fontSize: '0.813rem', color: 'text.secondary', fontWeight: 500 }}>
                                                    TX Control:
                                                </Typography>
                                                <Typography variant="body2" sx={{ fontSize: '0.813rem', color: 'text.primary' }}>
                                                    {rig.tx_control_mode || 'auto'}
                                                </Typography>

                                            </Box>
                                        </Box>
                                    );
                                })}
                            </Box>
                        </DialogContent>
                        <DialogActions
                            sx={{
                                bgcolor: (theme) => theme.palette.mode === 'dark' ? 'grey.900' : 'grey.50',
                                borderTop: (theme) => `1px solid ${theme.palette.divider}`,
                                px: 3,
                                py: 2,
                                gap: 1.5,
                            }}
                        >
                            <Button
                                onClick={() => dispatch(setOpenDeleteConfirm(false))}
                                variant="outlined"
                                color="inherit"
                                sx={{
                                    minWidth: 100,
                                    textTransform: 'none',
                                    fontWeight: 500,
                                }}
                            >
                                {t('rig.cancel')}
                            </Button>
                            <Button
                                variant="contained"
                                onClick={() => {
                                    handleDelete();
                                }}
                                color="error"
                                sx={{
                                    minWidth: 100,
                                    textTransform: 'none',
                                    fontWeight: 600,
                                }}
                            >
                                {t('rig.delete')}
                            </Button>
                        </DialogActions>
                    </Dialog>
                </Box>
            </Box>
        </Paper>
    );
}
